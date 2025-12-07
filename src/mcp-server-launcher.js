import GLib from "gi://GLib";
import Gio from "gi://Gio";

let subprocess = null;

export async function startMCPServer() {
  if (subprocess) return true;

  const path = getMCPServerPath();
  if (!path) return false;

  try {
    subprocess = Gio.Subprocess.new(
      ["gjs", "-m", path, "--http"],
      Gio.SubprocessFlags.NONE
    );
    return true;
  } catch (e) {
    console.error(`Failed to start MCP server: ${e}`);
    return false;
  }
}

export async function stopMCPServer() {
  if (!subprocess) return false;

  try {
    subprocess.force_exit();
    subprocess = null;
    return true;
  } catch (e) {
    console.error(`Failed to stop MCP server: ${e}`);
    return false;
  }
}

function getMCPServerPath() {
  const paths = [
    "/app/share/biblioteca/mcp-server.js",
    "/app/share/app.drey.Biblioteca.Devel/mcp-server.js",
    "/app/share/app.drey.Biblioteca/mcp-server.js",
    "/usr/share/biblioteca/mcp-server.js",
    "/usr/local/share/biblioteca/mcp-server.js",
    GLib.build_filenamev([GLib.get_current_dir(), "src/mcp-server/mcp-server.js"]),
  ];

  for (const path of paths) {
    if (path && GLib.file_test(path, GLib.FileTest.EXISTS)) return path;
  }
  return null;
}
