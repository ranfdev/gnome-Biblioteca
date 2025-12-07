import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

// ====================================================
// Section 1: Constants & Protocol Definitions (Spec 2025-06-18)
// ====================================================

const JSONRPC_VERSION = "2.0";
// Per Prompt Requirement
const PROTOCOL_VERSION = "2025-06-18"; 

const JSONRPC_ERRORS = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    SERVER_NOT_INITIALIZED: -32002,
    UNKNOWN_ERROR: -32001,
    REQUEST_CANCELLED: -32800 // Added per 2025 spec for cancellation
};

const LogLevel = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LogLevelNames = ['debug', 'info', 'warning', 'error']; // Lowercase for protocol compliance

export class RPCError extends Error {
    constructor(code, message, data = null) {
        super(message);
        this.code = code;
        this.data = data;
    }
}

// ====================================================
// Section 2: Validation Logic
// ====================================================

class Validator {
    /**
     * Validates data against a simplified JSON Schema.
     * Section 3.4: Dynamic Schema Validation
     */
    static validate(schema, data, path = '$') {
        if (!schema) return;

        // 1. Type Check
        if (schema.type) {
            const type = schema.type;
            const dataType = Array.isArray(data) ? 'array' : (data === null ? 'null' : typeof data);
            
            let valid = false;
            if (type === dataType) valid = true;
            else if (type === 'number' && dataType === 'number') valid = true;
            else if (type === 'integer' && Number.isInteger(data)) valid = true;
            else if (type === 'object' && dataType === 'object') valid = true;
            else if (type === 'string' && dataType === 'string') valid = true;
            else if (type === 'any') valid = true;

            if (!valid) {
                 throw new Error(`At ${path}: Expected type '${type}', got '${dataType}'`);
            }
        }

        // 2. Object Properties
        if (schema.type === 'object') {
            if (schema.required) {
                for (const field of schema.required) {
                    if (!(field in data)) {
                        throw new Error(`At ${path}: Missing required field '${field}'`);
                    }
                }
            }
            if (schema.properties && data) {
                for (const [key, propSchema] of Object.entries(schema.properties)) {
                    if (key in data) {
                        this.validate(propSchema, data[key], `${path}.${key}`);
                    }
                }
            }
        }
    }
}

// ====================================================
// Section 3: Transport Layer
// ====================================================

export class Transport {
    constructor() {
        this.onMessage = null; 
        this.onClose = null;
    }
    send(data) { throw new Error("Not implemented"); }
    close() {}
}

/**
 * Implementation of Standard Input/Output Transport
 * Spec Section 4.1: Stdio Transport
 */
export class StdioTransport extends Transport {
    constructor() {
        super();
        this._decoder = new TextDecoder('utf-8');
        // Use UnixInputStream to ensure we don't buffer excessively on the GJS side
        this._stdin = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: 0, close_fd: false }),
            newline_type: Gio.DataStreamNewlineType.LF
        });
        this._active = false;
    }

    start(mainLoop) {
        this._active = true;
        this._readLoop(mainLoop);
    }

    send(data) {
        // Critical: JSON-RPC over Stdio must be separated by newlines.
        // We use 'print' which appends a newline in GJS, but strictly 
        // using stdout.write is safer to avoid platform specific line endings.
        const json = JSON.stringify(data);
        print(json); 
    }

    _readLoop(mainLoop) {
        if (!this._active) return;

        // Read line async to prevent blocking the MainLoop
        this._stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            try {
                const [bytes] = stream.read_line_finish(res);
                
                if (bytes === null) {
                    // EOF detected
                    if (this.onClose) this.onClose();
                    mainLoop.quit();
                    return;
                }

                const line = this._decoder.decode(bytes).trim();
                if (line && this.onMessage) {
                    try {
                        const msg = JSON.parse(line);
                        this.onMessage(msg, null);
                    } catch (e) {
                        printerr(`[MCP-Stdio] JSON Parse Error: ${e.message}\n`);
                    }
                }
                
                // Recursively call to continue loop
                this._readLoop(mainLoop);

            } catch (e) {
                printerr(`[MCP-Stdio] Read Error: ${e.message}\n`);
                mainLoop.quit();
            }
        });
    }
}

/**
 * Implementation of HTTP with SSE (Server-Sent Events)
 * Spec Section 4.2: HTTP/SSE Transport
 */
export class HttpTransport extends Transport {
    constructor(port = 8080, logger) {
        super(logger);
        this.port = port;
        this.sessions = new Map(); // sessionId -> msg
        this.server = new Soup.Server();
    }

    start() {
        this.server.add_handler('/', this._handleRoot.bind(this));
        try {
            this.server.listen_all(this.port, 0);
            printerr(`[MCP-Http] Listening on port ${this.port}\n`);
        } catch (e) {
            printerr(`[MCP-Http] Failed to bind: ${e.message}\n`);
            throw e;
        }

        // Heartbeat to keep connections alive
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            this._broadcastHeartbeat();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _handleRoot(server, msg, path, query) {
        const method = msg.get_method(); // Fix: Use method getter per your example
        if (method === 'GET') this._handleSSE(server, msg, path, query);
        else if (method === 'POST') this._handlePost(server, msg, path, query);
        else msg.set_status(405, 'Method Not Allowed');
    }

    _handleSSE(server, msg, path, query) {
        // 1. Setup Headers for Chunked SSE
        msg.set_status(200, null);
        const headers = msg.get_response_headers();
        headers.set_encoding(Soup.Encoding.CHUNKED); // Tells libsoup to manage the stream
        headers.append("Content-Type", "text/event-stream");
        headers.append("Cache-Control", "no-cache");
        headers.append("Connection", "keep-alive");
        headers.append("Access-Control-Allow-Origin", "*");

        // 2. Disable Accumulation (Critical for memory)
        // We don't want to keep a history of every event sent in RAM
        msg.get_response_body().set_accumulate(false);

        const sessionId = GLib.uuid_string_random();
        
        // 3. Register Session
        this.sessions.set(sessionId, msg);

        // 4. Cleanup on Disconnect
        msg.connect('finished', () => {
            this.sessions.delete(sessionId);
            if (this.onClose) this.onClose(sessionId);
            printerr(`[MCP-Http] Session closed: ${sessionId}\n`);
        });

        printerr(`[MCP-Http] New Session: ${sessionId}\n`);

        // 5. Send Initial Endpoint Event
        // We do NOT manually pause. We just write the first chunk.
        // LibSoup will send it and then auto-pause I/O until we write again.
        const endpointUrl = `/message?sessionId=${sessionId}`;
        this._writeToSession(sessionId, `event: endpoint\ndata: ${endpointUrl}\n\n`);
    }

    _handlePost(server, msg, path, query) {
        const q = query || {};
        const sessionId = q['sessionId'];

        if (!sessionId || !this.sessions.has(sessionId)) {
            msg.set_status(400, 'Bad Request');
            return;
        }

        let body = "";
        const reqBody = msg.get_request_body();
        if (reqBody) body = new TextDecoder().decode(reqBody.flatten().toArray());

        try {
            const json = JSON.parse(body);
            if (this.onMessage) {
                // Async dispatch - strictly 202 Accepted
                this.onMessage(json, sessionId);
            }
            msg.set_status(202, 'Accepted');
            msg.set_response('text/plain', Soup.MemoryUse.COPY, new TextEncoder().encode("Accepted"));
        } catch (e) {
            msg.set_status(400, 'Bad Request');
        }
    }

    send(data, context) {
        const sessionId = context;
        if (!this.sessions.has(sessionId)) return;

        const eventData = JSON.stringify(data);
        const payload = `event: message\ndata: ${eventData}\n\n`;
        
        this._writeToSession(sessionId, payload);
    }

    _writeToSession(sessionId, payload) {
        const msg = this.sessions.get(sessionId);
        if (!msg) return;

        try {
            // 1. Append bytes to body
            msg.get_response_body().append_bytes(new GLib.Bytes(new TextEncoder().encode(payload)));
            
            // 2. The Critical Fix:
            // Use server.unpause_message() to trigger the write.
            // LibSoup will automatically pause again after writing this chunk.
            this.server.unpause_message(msg);
            
        } catch (e) {
            printerr(`[MCP-Http] Write Error: ${e.message}\n`);
            this.sessions.delete(sessionId);
        }
    }

    _broadcastHeartbeat() {
        const keepAlive = `: keepalive\n\n`;
        for (const id of this.sessions.keys()) {
            this._writeToSession(id, keepAlive);
        }
    }
}

// ====================================================
// Section 4: MCP Server Core
// ====================================================

export class MCPServer {
    constructor(name, version, options = {}) {
        this.serverInfo = { name, version };
        this.logLevel = LogLevel.INFO; // Default to INFO
        
        // Capabilities Definition
        this.capabilities = {
            tools: { listChanged: true }, 
            resources: { listChanged: true, subscribe: false },
            prompts: { listChanged: true },
            logging: {} // Declare logging support
        };
        
        this.registry = { 
            tools: new Map(),
            resources: new Map(),
            prompts: new Map()
        };

        this.sessionStates = new Map();
        this.mainLoop = new GLib.MainLoop(null, false);

        // Select Transport
        if (options.transport === 'http') {
            this.transport = new HttpTransport(options.port || 8080);
        } else {
            this.transport = new StdioTransport();
        }

        this.transport.onMessage = (msg, ctx) => this._processMessage(msg, ctx);
        this.transport.onClose = (ctx) => {
            const c = ctx || 'default';
            this.sessionStates.delete(c);
        };
    }

    /**
     * Registers a tool.
     */
    tool(name, description, inputSchema, handler) {
        this.registry.tools.set(name, {
            definition: { name, description, inputSchema },
            handler
        });
    }

    /**
     * Sends a log message to the client (Spec Section 5.2)
     */
    log(level, message, context = 'default') {
        // 1. Filter: Don't send if below the current set level
        if (level < this.logLevel) return;

        // 2. Prepare Protocol Level Name
        const levelName = LogLevelNames[level] || 'info';

        // 3. Send Notification
        // Only send if we have an active transport
        if (this.transport) {
            this.transport.send({
                jsonrpc: "2.0",
                method: 'logging/message',
                params: {
                    level: levelName,
                    data: message,
                    logger: this.serverInfo.name // Optional: helps client identify source
                }
            }, context);
        }

        // 4. Always print to Stderr for local debugging (optional but recommended)
        // You might want to skip Debug logs in stderr if not in verbose mode
        printerr(`[LOG-${levelName.toUpperCase()}] ${message}\n`);
    }

    start() {
        // Graceful Shutdown on SIGINT (Ctrl+C)
        // Unix signal handlers are provided by GLibUnix on modern
        // platforms.
        GLibUnix.signal_add_full(GLib.PRIORITY_DEFAULT, 2, () => {
                printerr("\n[MCP] Caught SIGINT, shutting down...\n");
                this.mainLoop.quit();
                return GLib.SOURCE_REMOVE;
        });

        if (this.transport.start) this.transport.start(this.mainLoop);
        
        printerr(`[MCP] Server '${this.serverInfo.name}' v${this.serverInfo.version} running (Proto: ${PROTOCOL_VERSION})\n`);
        this.mainLoop.run();
    }

    async _processMessage(msg, context) {
        const sessionKey = context || 'default';
        if (!msg || typeof msg !== 'object') return;
        
        const isRequest = msg.id !== undefined;

        try {
            // 1. Handshake: Initialize
            if (msg.method === 'initialize') {
                this.sessionStates.set(sessionKey, 'initializing');
                
                const response = {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: this.capabilities,
                    serverInfo: this.serverInfo
                };
                
                if (isRequest) this._sendResponse(msg.id, response, context);
                return;
            }

            // 2. Handshake: Initialized (Notification)
            if (msg.method === 'notifications/initialized') {
                this.sessionStates.set(sessionKey, 'ready');
                this.log(LogLevel.INFO, "Client handshake complete", context);
                return;
            }

            // 3. Enforce Lifecycle
            const state = this.sessionStates.get(sessionKey);
            if (state !== 'ready' && state !== 'initializing') {
                if (isRequest) {
                    throw new RPCError(JSONRPC_ERRORS.SERVER_NOT_INITIALIZED, "Server not initialized.");
                }
                return; 
            }

            // 4. Method Router
            switch (msg.method) {
                case 'ping':
                    if (isRequest) this._sendResponse(msg.id, {}, context);
                    break;
                
                case 'tools/list':
                    const tools = Array.from(this.registry.tools.values()).map(t => t.definition);
                    // Spec allows 'cursor' for pagination. We return all for now.
                    if (isRequest) this._sendResponse(msg.id, { tools }, context);
                    break;

                case 'tools/call':
                    if (!isRequest) return;
                    await this._handleToolCall(msg.id, msg.params, context);
                    break;

                case 'resources/list':
                    // Stub implementation to satisfy 'capabilities'
                    if (isRequest) this._sendResponse(msg.id, { resources: [] }, context);
                    break;

                case 'prompts/list':
                    // Stub implementation
                    if (isRequest) this._sendResponse(msg.id, { prompts: [] }, context);
                    break;
                case 'logging/setLevel':
                    // Validate params
                    if (!msg.params || typeof msg.params.level !== 'string') {
                        throw new RPCError(JSONRPC_ERRORS.INVALID_PARAMS, "Level required");
                    }

                    // Parse level string to integer
                    const newLevelStr = msg.params.level.toLowerCase();
                    const newLevelIdx = LogLevelNames.indexOf(newLevelStr);
                    
                    if (newLevelIdx !== -1) {
                        this.logLevel = newLevelIdx;
                        this.log(LogLevel.INFO, `Log level set to ${newLevelStr}`, context);
                    } 
                    // If the level is unknown (e.g. 'critical'), spec suggests defaulting 
                    // or clamping. We'll ignore or set to Error.

                    // Acknowledge the request
                    if (isRequest) this._sendResponse(msg.id, {}, context);
                    break;
                default:
                    if (isRequest) {
                        throw new RPCError(JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method ${msg.method} not found`);
                    }
            }

        } catch (error) {
            if (isRequest) {
                const code = error instanceof RPCError ? error.code : JSONRPC_ERRORS.INTERNAL_ERROR;
                this._sendError(msg.id, code, error.message, error.data, context);
            }
            printerr(`[MCP-Error] ${error.message}\n`);
        }
    }

    async _handleToolCall(requestId, params, context) {
        if (!params || !params.name) {
            throw new RPCError(JSONRPC_ERRORS.INVALID_PARAMS, "Missing tool name");
        }

        const tool = this.registry.tools.get(params.name);
        if (!tool) {
            throw new RPCError(JSONRPC_ERRORS.INVALID_PARAMS, `Tool '${params.name}' not found`);
        }

        // Validate Schema
        if (tool.definition.inputSchema) {
            try {
                Validator.validate(tool.definition.inputSchema, params.arguments || {});
            } catch (e) {
                throw new RPCError(JSONRPC_ERRORS.INVALID_PARAMS, `Validation Error: ${e.message}`);
            }
        }

        // Execute Tool
        try {
            const result = await tool.handler(params.arguments || {});
            
            // Handle CallToolResult format: { content: [...] }
            let callToolResult;
            if (result && typeof result === 'object') {
                // If result has a 'content' field, it's already in CallToolResult format
                if (Array.isArray(result.content)) {
                    callToolResult = result;
                } 
                // If result is an array of ContentItems, wrap it
                else if (Array.isArray(result)) {
                    callToolResult = { content: result };
                } 
                // Otherwise treat as content to be stringified
                else {
                    callToolResult = { 
                        content: [{ type: 'text', text: JSON.stringify(result) }]
                    };
                }
            } else if (typeof result === 'string') {
                // String result -> wrap as text content
                callToolResult = { 
                    content: [{ type: 'text', text: result }]
                };
            } else {
                // Any other type -> stringify it
                callToolResult = { 
                    content: [{ type: 'text', text: String(result) }]
                };
            }

            this._sendResponse(requestId, callToolResult, context);
        } catch (e) {
            printerr(`[MCP-Error] Tool '${params.name}' failed: ${e.message}\n`);
            if (e.stack) printerr(e.stack + '\n');

            this._sendResponse(requestId, { 
                content: [{ type: 'text', text: `Tool execution failed: ${e.message}` }],
                isError: true 
            }, context);
        }
    }

    _sendResponse(id, result, context) {
        this.transport.send({ jsonrpc: JSONRPC_VERSION, id, result }, context);
    }

    _sendError(id, code, message, data, context) {
        this.transport.send({ 
            jsonrpc: JSONRPC_VERSION, 
            id, 
            error: { code, message, data } 
        }, context);
    }
}