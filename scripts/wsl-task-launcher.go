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
	"regexp"
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

type dispatcherBinding struct {
	Registry string `json:"registry"`
}

type launcherBinding struct {
	Project     string
	Dispatcher  *dispatcherBinding `json:"dispatcher,omitempty"`
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

type taskDescriptor struct {
	SchemaVersion int
	Name          string
	Size          int64
	Hash          string
}

const windowsPathPrefix = `\\?\`

var (
	errChanged       = errors.New("pinned input changed")
	getFinalPathName = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFinalPathNameByHandleW")
	taskIDPattern    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	taskNamePattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	taskHashPattern  = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Resolve the open handle directly, including files in WindowsApps packages
// whose parent directories cannot be enumerated with FindFirstFile.
func canonicalPath(file *os.File, expected string) bool {
	var path [32768]uint16
	n, _, _ := getFinalPathName.Call(file.Fd(), uintptr(unsafe.Pointer(&path[0])), uintptr(len(path)), 0)
	if n == 0 || n >= uintptr(len(path)) {
		return false
	}
	resolved, ok := strings.CutPrefix(syscall.UTF16ToString(path[:n]), windowsPathPrefix)
	return ok && strings.EqualFold(resolved, expected)
}

func projectCwd(project string, pinned os.FileInfo) bool {
	cwd, err := os.Getwd()
	if err != nil {
		return false
	}
	dir, err := os.Open(cwd)
	if err != nil {
		return false
	}
	defer dir.Close()
	if pinned != nil {
		info, err := dir.Stat()
		if err != nil || !os.SameFile(info, pinned) {
			return false
		}
	}
	return canonicalPath(dir, project)
}

func openPinned(path string, share, flags uint32) (*os.File, os.FileInfo, error) {
	name, err := syscall.UTF16PtrFromString(windowsPathPrefix + filepath.Clean(path))
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

func matchesPin(file *os.File, info os.FileInfo, size int64, expectedHash string) bool {
	if !info.Mode().IsRegular() || info.Size() != size {
		return false
	}
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(file, size+1))
	return err == nil && n == size && hex.EncodeToString(hash.Sum(nil)) == expectedHash
}

// Keep verified installation inputs read-only while the validation process uses them.
func lockPin(pin filePin) (*os.File, error) {
	file, info, err := openPinned(pin.Path, syscall.FILE_SHARE_READ, 0)
	if err != nil {
		return nil, err
	}
	if matchesPin(file, info, pin.Size, pin.Hash) {
		return file, nil
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

// Deny writes and deletes while checking dispatcher inputs and starting the child.
func openPlain(path string, directory bool) (*os.File, os.FileInfo, error) {
	var flags uint32
	if directory {
		flags = syscall.FILE_FLAG_BACKUP_SEMANTICS
	}
	file, info, err := openPinned(path, syscall.FILE_SHARE_READ, flags)
	if err != nil {
		return nil, nil, err
	}
	var metadata syscall.ByHandleFileInformation
	err = syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &metadata)
	plain := info.Mode().IsRegular() && metadata.NumberOfLinks == 1
	if directory {
		plain = info.IsDir()
	}
	if err == nil && plain && metadata.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		return file, info, nil
	}
	file.Close()
	return nil, nil, errChanged
}

func readTaskDescriptor(file *os.File) (taskDescriptor, bool) {
	const limit = 4096
	var descriptor taskDescriptor
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || len(data) > limit {
		return descriptor, false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return descriptor, false
	}
	// Require the exact field names, each present exactly once.
	fields := map[string]any{
		"schemaVersion": &descriptor.SchemaVersion,
		"name":          &descriptor.Name,
		"size":          &descriptor.Size,
		"hash":          &descriptor.Hash,
	}
	for decoder.More() {
		key, err := decoder.Token()
		name, _ := key.(string)
		field := fields[name]
		if err != nil || field == nil || decoder.Decode(field) != nil {
			return descriptor, false
		}
		delete(fields, name)
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || len(fields) != 0 {
		return descriptor, false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return descriptor, false
	}
	return descriptor, descriptor.SchemaVersion == 1 && taskNamePattern.MatchString(descriptor.Name) &&
		descriptor.Size > 0 && descriptor.Size <= 32*1024*1024 && taskHashPattern.MatchString(descriptor.Hash)
}

func lockTaskLease(registry, generation, name, id string) (*os.File, error) {
	key := filepath.Base(registry)
	if !taskHashPattern.MatchString(key) {
		return nil, errChanged
	}
	input, err := json.Marshal([]string{"windows-agent-devkit-wsl-lease", key, name, id})
	if err != nil {
		return nil, err
	}
	want := sha256.Sum256(input)
	lease, _, err := openPlain(filepath.Join(generation, "active.lease"), false)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(lease, 2*sha256.Size+1))
	if err != nil || string(data) != hex.EncodeToString(want[:]) {
		lease.Close()
		return nil, errChanged
	}
	return lease, nil
}

func startProjectTask(binding launcherBinding, id string) (*os.Process, error) {
	project, info, err := openPlain(binding.Project, true)
	if err != nil {
		return nil, errors.New("The registered Windows project directory is missing or changed.")
	}
	defer project.Close()
	if !projectCwd(binding.Project, info) {
		return nil, errors.New("Run this WSL task from its registered Windows project directory.")
	}
	registry := binding.Dispatcher.Registry
	runnerDir := filepath.Join(registry, "project-runner-v1")
	for _, path := range []string{registry, runnerDir} {
		dir, _, err := openPlain(path, true)
		if err != nil {
			return nil, errors.New("The protected WSL project runner directories are missing or changed.")
		}
		defer dir.Close()
	}
	descriptorFile, _, err := openPlain(filepath.Join(runnerDir, id+".json"), false)
	if err != nil {
		return nil, errors.New("The WSL project task descriptor is missing or invalid.")
	}
	defer descriptorFile.Close()
	descriptor, ok := readTaskDescriptor(descriptorFile)
	if !ok {
		return nil, errors.New("The WSL project task descriptor is missing or invalid.")
	}
	nameDir := filepath.Join(registry, "task-"+descriptor.Name)
	generation := filepath.Join(nameDir, id)
	for _, path := range []string{nameDir, generation} {
		dir, _, err := openPlain(path, true)
		if err != nil {
			return nil, errors.New("The protected WSL task directories are missing or changed.")
		}
		defer dir.Close()
	}
	executable := filepath.Join(generation, "wsl-task.exe")
	child, info, err := openPlain(executable, false)
	if err != nil {
		return nil, errors.New("The registered WSL task launcher is missing or changed.")
	}
	defer child.Close()
	if !matchesPin(child, info, descriptor.Size, descriptor.Hash) {
		return nil, errors.New("The registered WSL task launcher is missing or changed.")
	}
	lease, err := lockTaskLease(registry, generation, descriptor.Name, id)
	if err != nil {
		return nil, errors.New("The WSL task lease is missing or changed.")
	}
	defer lease.Close()
	process, err := os.StartProcess(windowsPathPrefix+executable, []string{executable}, &os.ProcAttr{
		Dir: binding.Project,
		// A non-nil environment block prevents inheritance even if the binding is empty.
		Env:   append([]string{}, binding.Environment...),
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
		Sys:   &syscall.SysProcAttr{HideWindow: true},
	})
	if err != nil {
		return nil, errors.New("Could not start the registered WSL task launcher.")
	}
	return process, nil
}

func runDispatcher(binding launcherBinding, args []string) int {
	if len(args) != 1 || !taskIDPattern.MatchString(args[0]) {
		fmt.Fprintln(os.Stderr, "The WSL project runner requires exactly one lowercase version 4 UUID.")
		return 2
	}
	process, err := startProjectTask(binding, args[0])
	if err != nil {
		return fail(err.Error())
	}
	result, err := process.Wait()
	if err != nil {
		return fail("Could not wait for the registered WSL task launcher.")
	}
	return result.ExitCode()
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
	var binding launcherBinding
	if json.Unmarshal([]byte(bindingJSON), &binding) != nil {
		return fail("The WSL task launcher binding is invalid.")
	}
	if binding.Dispatcher != nil {
		return runDispatcher(binding, os.Args[1:])
	}
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "This WSL task launcher accepts no arguments.")
		return 2
	}
	if !liveLease(binding.Lease) {
		return fail("The WSL task lease is missing or changed.")
	}
	if !projectCwd(binding.Project, nil) {
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
