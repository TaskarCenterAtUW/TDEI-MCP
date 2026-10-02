export function portInUseHint(
  port: number,
  platform: string = process.platform,
): string {
  const find = platform === "win32"
    ? `netstat -ano | findstr :${port}   (last column is the PID), then: taskkill /PID <pid> /F`
    : `lsof -i :${port}   (or: ss -ltnp | grep :${port}), then: kill <pid>`;
  return `Port ${port} is in use. Find and stop the process holding it: ${find}. Or pick another port with --port <n> (init) / TDEI_SSO_CALLBACK_URL.`;
}
