"use strict";
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_debugadapter_1 = require("vscode-debugadapter");
const path_1 = require("path");
const net_1 = require("net");
const events_1 = require("events");
var ResponseEventType;
(function (ResponseEventType) {
    ResponseEventType[ResponseEventType["breakpoint_created"] = 0] = "breakpoint_created";
    ResponseEventType[ResponseEventType["stopped"] = 1] = "stopped";
    ResponseEventType[ResponseEventType["stack"] = 2] = "stack";
    ResponseEventType[ResponseEventType["source"] = 3] = "source";
    ResponseEventType[ResponseEventType["vars"] = 4] = "vars";
})(ResponseEventType || (ResponseEventType = {}));
class WrenDebugSession extends vscode_debugadapter_1.LoggingDebugSession {
    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    constructor() {
        super("wren-debug.txt");
        this._variableHandles = new vscode_debugadapter_1.Handles();
        this._breakpoints = new Map();
        this._response_events = new events_1.EventEmitter();
        this._response_event_names = new Map([[ResponseEventType.breakpoint_created, "breakpoint_created"], [ResponseEventType.stopped, "stopped"], [ResponseEventType.stack, "stack"], [ResponseEventType.source, "source"], [ResponseEventType.vars, "vars"]]);
        this._source_module_map = new Map();
        this._module_source_map = new Map();
        this._source_id = 1; //has to be 1 because 0 is interpreted as 'no id given'
        this._set_breakpoint_queue = new Array();
        this._stack_response_queue = new Array();
        this._source_response_queue = new Array();
        this._variables_response_queue = new Array();
        this._event_payload = "";
        this._event_type = -1;
        this._payload_length = -1;
        this._event_final = -1;
        console.log("debug adapter!!!!");
        // this debugger uses zero-based lines and columns
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(false);
        {
            let stopped_handler = (msg) => {
                let matchResult = msg.match(/stopped (\d+)/);
                if (matchResult) {
                    let reasonID = Number(matchResult[1]);
                    let reasonString = "";
                    switch (reasonID) {
                        case 1:
                            reasonString = "fiber switch";
                            break;
                        case 2:
                            reasonString = "step";
                            break;
                        case 3:
                            reasonString = "breakpoint";
                            break;
                    }
                    this.sendEvent(new vscode_debugadapter_1.StoppedEvent(reasonString, WrenDebugSession.THREAD_ID));
                }
            };
            this._response_events.on("stopped", stopped_handler);
        }
        {
            let created_ids = new Array();
            let breakpoint_created_handler = (msg) => {
                if (this._set_breakpoint_queue.length === 0) {
                    vscode_debugadapter_1.logger.warn("Got breakpoint created event without corresponding request in the queue!");
                    return;
                }
                let matchResult = msg.match(/created (\d+)/);
                if (matchResult) {
                    let breakpointID = Number(matchResult[1]);
                    created_ids.push(breakpointID);
                }
                //we had a response for every add we sent
                if (created_ids.length === this._set_breakpoint_queue[0].breakpoints.length) {
                    let request = this._set_breakpoint_queue.shift();
                    let wren_breakpoints_list = this._breakpoints.get(request.module);
                    let responseBreakpoints = new Array();
                    for (let i = 0; i < created_ids.length; i++) {
                        if (created_ids[i] === -1) {
                            continue;
                        }
                        ; //skip over invalid breakpoints
                        const wrenBreakpoint = { id: created_ids[i], line: request.breakpoints[i].line };
                        wren_breakpoints_list.push(wrenBreakpoint);
                        responseBreakpoints.push({ verified: true, id: created_ids[i], line: request.breakpoints[i].line });
                    }
                    request.response.body = {
                        breakpoints: responseBreakpoints
                    };
                    this.sendResponse(request.response);
                    created_ids.length = 0;
                }
            };
            this._response_events.on("breakpoint_created", breakpoint_created_handler.bind(this));
        }
        {
            let stack_handler = (msg) => {
                let frame_match = /(\d+)\|([^\|]+)\|([^\|]+)?\|([^\|]+)\|(\d+)/g;
                let match_results = frame_match.exec(msg);
                let frames = new Array();
                while (match_results) {
                    let id = Number(match_results[1]); //:todo: when using fibers this will not be unique anymore
                    let module = match_results[2];
                    let path = match_results[3];
                    let fn_name = match_results[4];
                    let line = Number(match_results[5]);
                    let source = new vscode_debugadapter_1.Source(module);
                    if (path) {
                        path = this.actually_normalize(path);
                        source.path = path;
                    }
                    else {
                        if (this._module_source_map.has(module)) {
                            source.sourceReference = this._module_source_map.get(module);
                        }
                        else {
                            source.sourceReference = this._source_id;
                            this._module_source_map.set(module, this._source_id);
                            this._source_module_map.set(this._source_id, module);
                            this._source_id++;
                        }
                    }
                    let stackframe = new vscode_debugadapter_1.StackFrame(id, fn_name, source, this.convertDebuggerLineToClient(line));
                    frames.push(stackframe);
                    match_results = frame_match.exec(msg);
                }
                let response = this._stack_response_queue.shift();
                if (!response) {
                    vscode_debugadapter_1.logger.error("Got a stack event without corresponding response in queue!");
                    return;
                }
                response.body = {
                    stackFrames: frames.reverse(),
                    totalFrames: frames.length
                };
                this.sendResponse(response);
            };
            this._response_events.on("stack", stack_handler);
        }
        {
            let source_handler = (msg) => {
                let response = this._source_response_queue.shift();
                if (!response) {
                    vscode_debugadapter_1.logger.error("Got source event without corresponding response in queue!");
                    return;
                }
                if (!response.body) {
                    response.body = { content: "" };
                }
                response.body.content = msg;
                this.sendResponse(response);
            };
            this._response_events.on("source", source_handler);
        }
        {
            let module_vars_handler = (msg) => {
                let response = this._variables_response_queue.shift();
                if (!response) {
                    vscode_debugadapter_1.logger.error("Got module vars event without corresponding response in queue!");
                    return;
                }
                let variables = new Array();
                while (msg.length > 0) {
                    let match_results = msg.match(/(\w+)\|(\w+)\|(\d+)\|/);
                    if (match_results) {
                        let var_name = match_results[1];
                        let type_name = match_results[2];
                        let printed_len = Number(match_results[3]);
                        let printed_val = msg.substr(match_results.index + match_results[0].length, printed_len);
                        variables.push({
                            name: var_name,
                            type: type_name,
                            value: printed_val,
                            variablesReference: 0
                        });
                        msg = msg.substring(match_results.index + match_results[0].length + printed_len + 1); //rest of message after the \n for this var
                    }
                }
                response.body = {
                    variables: variables
                };
                this.sendResponse(response);
            };
            this._response_events.on("vars", module_vars_handler);
        }
    }
    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    initializeRequest(response, args) {
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        response.body = response.body || {};
        // This debug adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;
        // make VS Code to use 'evaluate' when hovering over source
        // response.body.supportsEvaluateForHovers = true;
        // make VS Code to show a 'step back' button
        // response.body.supportsStepBack = true;
        this.sendResponse(response);
        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        // this.sendEvent(new InitializedEvent());
        //:todo: was this desirable?
        console.log("wtfff");
    }
    /**
     * Called at the end of the configuration sequence.
     * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
     */
    configurationDoneRequest(response, args) {
        super.configurationDoneRequest(response, args);
        // notify the launchRequest that configuration has finished
        //this._configurationDone.notify(); //:todo: launch and attach
    }
    launchRequest(response, args) {
        return __awaiter(this, void 0, void 0, function* () {
            // make sure to 'Stop' the buffered logging if 'trace' is not set
            vscode_debugadapter_1.logger.setup(args.trace ? vscode_debugadapter_1.Logger.LogLevel.Verbose : vscode_debugadapter_1.Logger.LogLevel.Stop, false);
            // wait until configuration has finished (and configurationDoneRequest has been called)
            // await this._configurationDone.wait(1000);
            // start the program in the runtime
            // this._runtime.start(args.program, !!args.stopOnEntry);
            this.sendResponse(response);
        });
    }
    attachRequest(response, args) {
        this._projectRoot = args.projectRoot;
        // make sure to 'Stop' the buffered logging if 'trace' is not set
        vscode_debugadapter_1.logger.setup(args.trace ? vscode_debugadapter_1.Logger.LogLevel.Verbose : vscode_debugadapter_1.Logger.LogLevel.Stop, false);
        this._socket = net_1.createConnection(8089, "127.0.0.1", () => {
            this.sendEvent(new vscode_debugadapter_1.InitializedEvent());
        });
        this._socket.on('error', (error) => {
            vscode_debugadapter_1.logger.error('failed to connect socket (${error})');
            //No need to send termianted since we always get a closed event at the end
        });
        this._socket.on('close', () => {
            vscode_debugadapter_1.logger.log('socket closed');
            this.sendEvent(new vscode_debugadapter_1.TerminatedEvent());
        });
        this._socket.on("connect", () => {
            vscode_debugadapter_1.logger.log("socket opened!");
            console.log("socket connected!");
        });
        this._socket.on('data', (data) => {
            let msg = data.toString();
            console.log("debug `" + msg + "`");
            vscode_debugadapter_1.logger.log(msg, vscode_debugadapter_1.Logger.LogLevel.Verbose);
            while (msg.length > 0) {
                let new_msg = this.process_response_data(msg);
                if (new_msg === msg) {
                    vscode_debugadapter_1.logger.error("No change to the message after trying to process it! Stopping the process loop.");
                    break;
                }
                else {
                    msg = new_msg;
                }
            }
        });
        this.sendResponse(response);
    }
    process_response_data(msg) {
        if (this._event_type === -1) {
            let match_results = msg.match(/event: (\d+)\n/);
            if (match_results) {
                let event_type = Number(match_results[1]);
                this._event_type = event_type;
                msg = msg.substring(match_results.index + match_results[0].length);
            }
        }
        if (this._payload_length === -1) {
            let match_results = msg.match(/length: (\d+)\n/);
            if (match_results) {
                let length = Number(match_results[1]);
                this._payload_length = length;
                msg = msg.substring(match_results.index + match_results[0].length);
            }
        }
        if (this._event_final === -1) {
            let match_results = msg.match(/final: (\d)\n/);
            if (match_results) {
                let final = Number(match_results[1]);
                this._event_final = final;
                msg = msg.substring(match_results.index + match_results[0].length);
            }
        }
        if (this._payload_length !== -1) {
            let add_len = msg.length < this._payload_length ? msg.length : this._payload_length;
            this._event_payload += msg.substring(0, add_len);
            this._payload_length -= add_len;
            msg = msg.substring(add_len);
            if (this._payload_length === 0) {
                if (this._event_final === 1) {
                    let event_name = this._response_event_names.get(this._event_type); //:todo: why not go just by event type number?
                    this._response_events.emit(event_name, this._event_payload);
                    this._event_payload = "";
                }
                this._event_type = -1;
                this._payload_length = -1;
                this._event_final = -1;
            }
        }
        return msg;
    }
    disconnectRequest(response, args) {
        //remove all breakpoints and set the program going again so it doesn't get stuck from disconnecting
        this._breakpoints.forEach((value, key) => {
            this.clearBreakpoints(key, value);
        });
        this._socket.write("cont\n");
        this._socket.end();
        this.sendResponse(response);
    }
    clearBreakpoints(module, breakpoints) {
        for (let breakpoint of breakpoints) {
            this._socket.write("delp " + module + " " + breakpoint.line + "\n");
        }
        breakpoints.length = 0;
    }
    //:todo: obviously but this is annoying.
    actually_normalize(path) {
        let result = path_1.normalize(path);
        result = result.replace(/\\\\/g, '/');
        result = result.replace(/\\/g, '/');
        return result;
    }
    setBreakPointsRequest(response, args) {
        let root = this.actually_normalize(this._projectRoot);
        let source = this.actually_normalize(args.source.path);
        let module = path_1.relative(root, source);
        module = path_1.join(path_1.dirname(module), path_1.basename(module, ".wren"));
        module = this.actually_normalize(module);
        console.log("adding breaking to `" + module + "`");
        let breakpoints = this._breakpoints.get(module);
        if (breakpoints) {
            this.clearBreakpoints(module, breakpoints);
        }
        else {
            breakpoints = new Array();
            this._breakpoints.set(module, breakpoints);
        }
        const argBreakpoints = args.breakpoints || [];
        if (argBreakpoints.length !== 0) { // do not add a request in the queue if we won't send anything that we'll get a response from the debugger for
            this._set_breakpoint_queue.push({ module: module, breakpoints: argBreakpoints, response: response });
            for (let breakpoint of argBreakpoints) {
                var cmd = "addp " + module + " " + breakpoint.line + "\n";
                this._socket.write(cmd, function () {
                    console.log(arguments.length);
                });
            }
        }
    }
    threadsRequest(response) {
        // runtime supports now threads so just return a default thread.
        response.body = {
            threads: [
                new vscode_debugadapter_1.Thread(WrenDebugSession.THREAD_ID, "thread 1")
            ]
        };
        this.sendResponse(response);
    }
    stackTraceRequest(response, args) {
        this._stack_response_queue.push(response);
        let root = this.actually_normalize(this._projectRoot);
        this._socket.write("stack \"" + root + "\"\n");
    }
    sourceRequest(response, args) {
        let ref = (args.source ? args.source.sourceReference : args.sourceReference);
        let module_name = this._source_module_map.get(ref);
        if (module_name) {
            this._source_response_queue.push(response);
            this._socket.write("source \"" + module_name + "\"");
        }
        else {
            vscode_debugadapter_1.logger.warn("No module name known for source reference " + ref);
        }
    }
    scopesRequest(response, args) {
        const frameReference = args.frameId;
        vscode_debugadapter_1.logger.log("Scopes for frame: " + frameReference);
        const scopes = new Array();
        scopes.push(new vscode_debugadapter_1.Scope("Module", this._variableHandles.create("module_" + frameReference), false));
        scopes.push(new vscode_debugadapter_1.Scope("Function", this._variableHandles.create("function_" + frameReference), false));
        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    }
    variablesRequest(response, args) {
        const ref_str = this._variableHandles.get(args.variablesReference);
        if (ref_str !== null) {
            //:todo; this is overkill, could just make handle ids match cmd syntax
            let match_results = ref_str.match(/(module|function)_(\d+)/);
            if (match_results) {
                let section = match_results[1];
                let stack_idx = Number(match_results[2]) - 1; //convert from vscode stack references (start at 1) to wren debugger ones (start at 0)
                this._variables_response_queue.push(response);
                this._socket.write("info " + section + " " + stack_idx + "\n");
            }
        }
    }
    continueRequest(response, args) {
        this._socket.write("cont\n");
        this.sendResponse(response);
    }
    nextRequest(response, args) {
        // this._runtime.step();
        this._socket.write("over\n");
        this.sendResponse(response);
    }
    stepInRequest(response, args) {
        this._socket.write("into\n");
        this.sendResponse(response);
    }
    stepOutRequest(response, args) {
        this._socket.write("out\n");
        this.sendResponse(response);
    }
    evaluateRequest(response, args) {
        // response.body = {
        // 	result: `evaluate(context: '${args.context}', '${args.expression}')`,
        // 	variablesReference: 0
        // };
        this.sendResponse(response);
    }
}
// we don't support multiple threads, so we can use a hardcoded ID for the default thread
WrenDebugSession.THREAD_ID = 1;
exports.WrenDebugSession = WrenDebugSession;
//# sourceMappingURL=wrenDebug.js.map