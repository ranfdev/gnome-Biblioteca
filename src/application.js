import Adw from "gi://Adw";

import Actions from "./actions.js";
import { settings } from "./util.js";
import Window from "./window.js";
import { startMCPServer, stopMCPServer } from "./mcp-server-launcher.js";

const application = new Adw.Application({
  application_id: pkg.name,
  // Defaults to /app/drey/Biblioteca/Devel
  // if pkg.name is app.drey.Biblioteca.Devel
  resource_base_path: "/app/drey/Biblioteca",
});

let window;
application.connect("activate", () => {
  if (!window) {
    window = new Window({ application });
  }
  setColorScheme();
  window.open();

  // Start the MCP server on app activation
  // Using --http mode on port 8080 for external tool integration
  startMCPServer({
    port: 8080,
    debug: __DEV__, // Enable debug logging in development
  }).then((success) => {
    if (success) {
      if (__DEV__) console.log("MCP server started successfully");
    } else {
      console.warn("Failed to start MCP server - some features may not work");
    }
  });
});

application.set_option_context_description(
  "<https://github.com/workbenchdev/Biblioteca>",
);

// Handle cleanup when the application is shutting down
application.connect("shutdown", () => {
  stopMCPServer(__DEV__).then((stopped) => {
    if (stopped && __DEV__) {
      console.log("MCP server stopped");
    }
  });
});

Actions({ application });

function setColorScheme() {
  const style_manager = Adw.StyleManager.get_default();
  const color_scheme = settings.get_int("color-scheme");
  style_manager.set_color_scheme(color_scheme);
}
settings.connect("changed::color-scheme", setColorScheme);

export default application;
