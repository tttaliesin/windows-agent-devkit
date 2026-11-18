param([Parameter(Mandatory = $true)][string]$SettingsPath)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$settings = $null
try {
    if (-not $IsWindows -or (Get-Item -LiteralPath $SettingsPath).Length -gt 262144) { throw 'settings' }
    $settings = Get-Content -LiteralPath $SettingsPath -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
    if ($settings.token -notmatch '^[a-f0-9]{64}$' -or $settings.timeoutMs -lt 1 -or $settings.timeoutMs -gt 3600000) { throw 'settings' }
    # Windows 11 / PowerShell 7; native APIs checked against Microsoft Learn 2026-11-17.
    # JOB_LIST makes assignment atomic even if this owner dies between CreateProcess and ResumeThread.
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DevkitOwnedJob {
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public Limits Basic;
        public Io Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, Total, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, CountX, CountY, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int info, out Accounting accounting, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref Security security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool value) { if (!value) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    static uint Active(IntPtr job) {
        Accounting state;
        Check(QueryInformationJobObject(job, 1, out state, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
        return state.Active;
    }
    static string Quote(string value) {
        var output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            output.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            output.Append(c); slashes = 0;
        }
        return output.Append('\\', slashes * 2).Append('"').ToString();
    }
    static void Emit(string token, string kind, uint pid, long code, bool forced, uint active, string reason) {
        Console.Out.WriteLine("{\"protocol\":1,\"token\":\"" + token + "\",\"event\":\"" + kind
            + "\",\"pid\":" + pid + ",\"exitCode\":" + (code < 0 ? "null" : code.ToString(System.Globalization.CultureInfo.InvariantCulture))
            + ",\"forced\":" + (forced ? "true" : "false") + ",\"activeProcesses\":" + active
            + ",\"reason\":\"" + reason + "\"}");
        Console.Out.Flush();
    }
    public static int Run(string exe, string[] args, string cwd, int timeoutMs, int cleanupMs, string token) {
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero, nul = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        bool attributesReady = false, forced = false, failed = false;
        long exitCode = -1;
        uint active = uint.MaxValue;
        string reason = "natural_exit";
        try {
            job = CreateJobObjectW(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()));
            var security = new Security { Size = Marshal.SizeOf<Security>(), Inherit = 1 };
            nul = CreateFileW("NUL", 0xC0000000, 3, ref security, 3, 0, IntPtr.Zero);
            Check(nul != new IntPtr(-1));
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            Check(size.ToInt64() > 0 && size.ToInt64() <= 65536);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size)); attributesReady = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(handles, nul);
            jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupEx();
            startup.Startup.Size = Marshal.SizeOf<StartupEx>(); startup.Attributes = attributes;
            startup.Startup.Flags = 0x100; startup.Startup.Input = nul; startup.Startup.Output = nul; startup.Startup.Error = nul;
            var command = new StringBuilder(Quote(exe));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            // Console.In's synchronized reader can complete ReadLineAsync synchronously.
            var control = System.Threading.Tasks.Task.Run(() => Console.In.ReadLine());
            if (!control.IsCompleted) {
                // Only NUL is inherited; the child cannot spoof the owner's stdout handshake.
                Check(CreateProcessW(exe, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080404, IntPtr.Zero, cwd, ref startup, out process));
                if (!AssignProcessToJobObject(job, process.Process)) {
                    bool member;
                    Check(IsProcessInJob(process.Process, job, out member) && member);
                }
                Check(ResumeThread(process.Thread) != uint.MaxValue);
                Emit(token, "started", process.Pid, -1, false, Active(job), "job_assigned");
                var clock = Stopwatch.StartNew();
                while (true) {
                    uint wait = WaitForSingleObject(process.Process, 25);
                    Check(wait != uint.MaxValue);
                    if (wait == 0) break;
                    if (control.IsCompleted || clock.ElapsedMilliseconds >= timeoutMs) {
                        forced = true; reason = control.IsCompleted ? "stop_requested" : "timed_out";
                        Check(TerminateJobObject(job, 1)); break;
                    }
                }
            } else { forced = true; reason = "owner_disconnected"; }
        } catch { failed = true; reason = "native_failure"; }
        finally {
            if (job != IntPtr.Zero) {
                try {
                    if (process.Process != IntPtr.Zero) {
                        if (failed && WaitForSingleObject(process.Process, 0) != 0) { forced = true; Check(TerminateJobObject(job, 1)); }
                        if (WaitForSingleObject(process.Process, (uint)cleanupMs) == 0) {
                            uint code; Check(GetExitCodeProcess(process.Process, out code)); exitCode = code;
                        }
                        // Release root references before distinguishing accounting lag from orphans.
                        if (process.Thread != IntPtr.Zero) { CloseHandle(process.Thread); process.Thread = IntPtr.Zero; }
                        CloseHandle(process.Process); process.Process = IntPtr.Zero;
                    }
                    if (reason == "natural_exit") {
                        var settle = Stopwatch.StartNew();
                        while (Active(job) > 0 && settle.ElapsedMilliseconds < 50) Thread.Sleep(5);
                    }
                    if (Active(job) > 0) {
                        forced = true;
                        if (reason == "natural_exit") reason = "remaining_descendants";
                        Check(TerminateJobObject(job, 1));
                    }
                    var cleanup = Stopwatch.StartNew();
                    do { active = Active(job); if (active == 0) break; Thread.Sleep(10); }
                    while (cleanup.ElapsedMilliseconds < cleanupMs);
                } catch { failed = true; reason = "cleanup_unverified"; }
            }
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            if (nul != IntPtr.Zero && nul != new IntPtr(-1)) CloseHandle(nul);
            if (job != IntPtr.Zero) CloseHandle(job);
            Emit(token, "finished", process.Pid, exitCode, forced, active, failed ? reason : active == 0 ? reason : "cleanup_unverified");
        }
        return failed || active != 0 ? 1 : 0;
    }
}
'@
    exit [DevkitOwnedJob]::Run([string]$settings.executable, [string[]]$settings.arguments, [string]$settings.cwd,
        [int]$settings.timeoutMs, [int]$settings.cleanupMs, [string]$settings.token)
} catch {
    # Exceptions may contain arguments or configuration; emit no raw errors.
    exit 1
}
