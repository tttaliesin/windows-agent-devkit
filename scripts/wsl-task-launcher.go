// The provisioner builds this file with a private, generated bindings.go.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

type filePin struct {
	Path string
	Size int64
	Hash string
}

type launcherBinding struct {
	Project     string
	Fixture     string
	State       string
	Lease       filePin
	Files       []filePin
	Node        string
	Wsl         string
	Cli         string
	Distro      string
	LinuxCwd    string
	Version     string
	CLIArgs     []string
	Environment []string
	Probe       struct {
		Args     []string
		Expected string
	}
}

type validationStep struct {
	Phase     string `json:"phase"`
	Status    string `json:"status"`
	Execution string `json:"execution"`
	ExitCode  *int   `json:"exitCode"`
}

type linuxContext struct {
	Distro string `json:"distro"`
	Cwd    string `json:"cwd"`
	OS     string `json:"os"`
}

type validationCheck struct {
	CheckID   string `json:"checkId"`
	Status    string `json:"status"`
	Execution string `json:"execution"`
	Evidence  struct {
		Context *linuxContext    `json:"context"`
		Steps   []validationStep `json:"steps"`
	} `json:"evidence"`
}

type validationReport struct {
	Version string            `json:"pluginVersion"`
	Checks  []validationCheck `json:"checks"`
}

type receipt struct {
	Version     string         `json:"pluginVersion"`
	CheckID     string         `json:"checkId"`
	Status      string         `json:"status"`
	Task        validationStep `json:"task"`
	CLIExitCode int            `json:"cliExitCode"`
	Context     *linuxContext  `json:"context"`
	Verified    bool           `json:"verified"`
}

var (
	errChanged       = errors.New("pinned input changed")
	getFinalPathName = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFinalPathNameByHandleW")
)

// Resolve the open handle directly, including files in WindowsApps packages
// whose parent directories cannot be enumerated with FindFirstFile.
func canonicalPath(file *os.File, expected string) bool {
	var path [32768]uint16
	n, _, _ := getFinalPathName.Call(file.Fd(), uintptr(unsafe.Pointer(&path[0])), uintptr(len(path)), 0)
	if n == 0 || n >= uintptr(len(path)) {
		return false
	}
	resolved, ok := strings.CutPrefix(syscall.UTF16ToString(path[:n]), `\\?\`)
	return ok && strings.EqualFold(resolved, expected)
}

func projectCwd(project string) bool {
	cwd, err := os.Getwd()
	if err != nil {
		return false
	}
	dir, err := os.Open(cwd)
	if err != nil {
		return false
	}
	defer dir.Close()
	return canonicalPath(dir, project)
}

func openPinned(path string, share, flags uint32) (*os.File, os.FileInfo, error) {
	name, err := syscall.UTF16PtrFromString(`\\?\` + filepath.Clean(path))
	if err != nil {
		return nil, nil, errChanged
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, share, nil, syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_OPEN_REPARSE_POINT|flags, 0)
	if err != nil {
		return nil, nil, errChanged
	}
	file := os.NewFile(uintptr(handle), path)
	info, err := file.Stat()
	if err != nil || !canonicalPath(file, path) {
		file.Close()
		return nil, nil, errChanged
	}
	return file, info, nil
}

func lockDir(path string, empty bool) (*os.File, error) {
	dir, info, err := openPinned(path, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, syscall.FILE_FLAG_BACKUP_SEMANTICS)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		if !empty {
			return dir, nil
		}
		if _, err := dir.Readdirnames(1); err == io.EOF {
			return dir, nil
		}
	}
	dir.Close()
	return nil, errChanged
}

// Keep verified installation inputs read-only while the validation process uses them.
func lockPin(pin filePin) (*os.File, error) {
	file, info, err := openPinned(pin.Path, syscall.FILE_SHARE_READ, 0)
	if err != nil {
		return nil, err
	}
	if info.Mode().IsRegular() && info.Size() == pin.Size {
		hash := sha256.New()
		n, hashErr := io.Copy(hash, io.LimitReader(file, pin.Size+1))
		if hashErr == nil && n == pin.Size && hex.EncodeToString(hash.Sum(nil)) == pin.Hash {
			return file, nil
		}
	}
	file.Close()
	return nil, errChanged
}

func liveLease(pin filePin) bool {
	file, err := lockPin(pin)
	if err != nil {
		return false
	}
	return file.Close() == nil
}

type boundedOutput struct {
	data  bytes.Buffer
	limit int
}

func (output *boundedOutput) Write(data []byte) (int, error) {
	if len(data) > output.limit-output.data.Len() {
		return 0, errors.New("command output exceeded its limit")
	}
	return output.data.Write(data)
}

func capture(timeout time.Duration, path string, args []string, binding launcherBinding, limit int) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Dir = binding.Fixture
	cmd.Env = binding.Environment
	cmd.WaitDelay = 3 * time.Second
	output := boundedOutput{limit: limit}
	cmd.Stdout = &output
	err := cmd.Run()
	return output.data.Bytes(), err
}

func confirmedTask(output []byte, binding launcherBinding) (receipt, bool) {
	var report validationReport
	if json.Unmarshal(output, &report) != nil || report.Version != binding.Version {
		return receipt{}, false
	}
	var selected *validationCheck
	for i := range report.Checks {
		if report.Checks[i].CheckID == "WSL-02" {
			if selected != nil {
				return receipt{}, false
			}
			selected = &report.Checks[i]
		}
	}
	if selected == nil || selected.Status != "pass" || selected.Execution != "succeeded" {
		return receipt{}, false
	}
	scope := selected.Evidence.Context
	if scope == nil || scope.OS != "Linux" || scope.Distro != binding.Distro || scope.Cwd != binding.LinuxCwd {
		return receipt{}, false
	}
	var task *validationStep
	for i := range selected.Evidence.Steps {
		if selected.Evidence.Steps[i].Phase == "task" {
			if task != nil {
				return receipt{}, false
			}
			task = &selected.Evidence.Steps[i]
		}
	}
	if task == nil || task.Status != "pass" || task.Execution != "succeeded" || task.ExitCode == nil || *task.ExitCode != 0 {
		return receipt{}, false
	}
	return receipt{report.Version, selected.CheckID, selected.Status, *task, 0, scope, true}, true
}

func fail(message string) int {
	fmt.Fprintln(os.Stderr, message)
	return 1
}

func run() int {
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "This WSL task launcher accepts no arguments.")
		return 2
	}
	var binding launcherBinding
	if json.Unmarshal([]byte(bindingJSON), &binding) != nil {
		return fail("The WSL task launcher binding is invalid.")
	}
	if !liveLease(binding.Lease) {
		return fail("The WSL task lease is missing or changed.")
	}
	if !projectCwd(binding.Project) {
		return fail("Run this WSL task from its registered Windows project directory.")
	}
	fixture, err := lockDir(binding.Fixture, true)
	if err != nil {
		return fail("The protected WSL validation directories are missing or changed.")
	}
	defer fixture.Close()
	state, err := lockDir(binding.State, false)
	if err != nil {
		return fail("The protected WSL validation directories are missing or changed.")
	}
	defer state.Close()
	for _, pin := range binding.Files {
		file, err := lockPin(pin)
		if err != nil {
			return fail("A pinned WSL launcher input is missing or changed.")
		}
		defer file.Close()
	}
	probe, err := capture(15*time.Second, binding.Wsl, binding.Probe.Args, binding, 16384)
	if err != nil || string(probe) != binding.Probe.Expected {
		return fail("The registered Linux working directory or executable could not be verified.")
	}
	if !liveLease(binding.Lease) {
		return fail("The WSL task lease is missing or changed.")
	}
	output, err := capture(90*time.Second, binding.Node, append([]string{binding.Cli}, binding.CLIArgs...), binding, 2*1024*1024)
	if err != nil {
		return fail("The registered WSL task failed validation.")
	}
	result, ok := confirmedTask(output, binding)
	if !ok {
		return fail("The validation report did not confirm the registered WSL task.")
	}
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		return fail("Could not write the WSL task validation result.")
	}
	return 0
}

func main() {
	os.Exit(run())
}
