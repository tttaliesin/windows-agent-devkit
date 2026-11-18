const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const ARCH = /^(?:amd64|arm64|arm|386|ppc64le|s390x|riscv64|mips64le|x86_64|aarch64|i686|armv[5-8]l)$/;
export const safe = (value, pattern = NAME) => typeof value === 'string' && pattern.test(value);
export const validPath = (value) => typeof value === 'string' && value.length > 0 && value.length < 32768 && !/[\0\r\n]/.test(value);
export const argv = (value) => Array.isArray(value) && value.length <= 128 && value.every((arg) => typeof arg === 'string' && arg.length <= 32768 && !arg.includes('\0'));
export const list = (value) => Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every((item) => safe(item));
export const linuxPath = (value) => validPath(value) && value.startsWith('/') && !value.startsWith('//');
export const linuxTool = (value) => linuxPath(value) && !/^\/mnt\/[a-z](?:\/|$)/i.test(value)
  && !/\.(?:exe|cmd|bat|ps1)$/i.test(value) && !/\/(?:shims?|proxies)\//i.test(value)
  && !/\/\.cargo\/bin\/(?:rustc|cargo)$/i.test(value);
