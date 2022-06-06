/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, //BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { relative, basename, join, dirname, normalize } from 'path';
import { Socket, createConnection } from 'net';
import { EventEmitter } from 'events';


interface WrenBreakpoint {
	id: number;
	line: number;
}

enum ResponseEventType {
	breakpoint_created = 0,
	stopped = 1,
	stack = 2,
	source = 3,
	vars = 4
}

interface SetBreakpointsRequest {
	module: string,
	breakpoints: Array<DebugProtocol.SourceBreakpoint>,
	response: DebugProtocol.SetBreakpointsResponse
}

/**
 * This interface should always match the schema found in the mock-debug extension manifest.
 */
interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	/** An absolute path to the code file to debug. */
	projectRoot: string;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}

export class WrenDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	private _variableHandles = new Handles<string>();

	private _socket : Socket;
	private _breakpoints = new Map<string, WrenBreakpoint[]>();
	private _projectRoot : string;
	private _response_events = new EventEmitter();
	private _response_event_names = new Map<ResponseEventType, string>([[ResponseEventType.breakpoint_created, "breakpoint_created"], [ResponseEventType.stopped, "stopped"], [ResponseEventType.stack, "stack"], [ResponseEventType.source, "source"], [ResponseEventType.vars, "vars"]]);
	private _source_module_map = new Map<number, string>();
	private _module_source_map = new Map<string, number>();
	private _source_id = 1; //has to be 1 because 0 is interpreted as 'no id given'

	private _set_breakpoint_queue = new Array<SetBreakpointsRequest>();
	private _stack_response_queue = new Array<DebugProtocol.StackTraceResponse>();
	private _source_response_queue = new Array<DebugProtocol.SourceResponse>();
	private _variables_response_queue = new Array<DebugProtocol.VariablesResponse>();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {

		super("wren-debug.txt");
		console.log("debug adapter!!!!");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(false);

		{
			let stopped_handler = (msg:string) => {
				let matchResult = msg.match(/stopped (\d+)/);
				if(matchResult) {
					let reasonID = Number(matchResult[1]);
					let reasonString = "";
					switch(reasonID) {
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

					this.sendEvent(new StoppedEvent(reasonString, WrenDebugSession.THREAD_ID));
				}
			}
			this._response_events.on("stopped", stopped_handler);
		}

		{
			let created_ids = new Array<Number>();

			let breakpoint_created_handler = (msg:string) => {
				if(this._set_breakpoint_queue.length === 0) {
					logger.warn("Got breakpoint created event without corresponding request in the queue!");
					return;
				}

				let matchResult = msg.match(/created (\d+)/);

				if(matchResult) {
					let breakpointID = Number(matchResult[1]);
					created_ids.push(breakpointID);
				}

					//we had a response for every add we sent
				if(created_ids.length === this._set_breakpoint_queue[0].breakpoints.length) {
					let request = <SetBreakpointsRequest>this._set_breakpoint_queue.shift();
					let wren_breakpoints_list = <WrenBreakpoint[]>this._breakpoints.get(request.module);

					let responseBreakpoints = new Array<Breakpoint>();

					for(let i=0; i<created_ids.length; i++) {
						if(created_ids[i] === -1) { continue }; //skip over invalid breakpoints

						const wrenBreakpoint = <WrenBreakpoint> {id: created_ids[i], line: request.breakpoints[i].line};
						wren_breakpoints_list.push(wrenBreakpoint);

						responseBreakpoints.push(<Breakpoint>{verified: true, id: created_ids[i], line: request.breakpoints[i].line});
					}

					request.response.body = {
						breakpoints: responseBreakpoints
					};


					this.sendResponse(request.response);

					created_ids.length = 0;
				}
			}

			this._response_events.on("breakpoint_created", breakpoint_created_handler.bind(this));
		}

		{
			let stack_handler = (msg:string) => {
				let frame_match = /(\d+)\|([^\|]+)\|([^\|]+)?\|([^\|]+)\|(\d+)/g;
				let match_results = frame_match.exec(msg);

				let frames = new Array<StackFrame>();

				while(match_results) {
					let id = Number(match_results[1]); //:todo: when using fibers this will not be unique anymore
					let module = match_results[2];
					let path = match_results[3];
					let fn_name = match_results[4];
					let line = Number(match_results[5]);

					let source:Source = new Source(module);

					if(path) {
						path = this.actually_normalize(path);
						source.path = path;
					} else {
						if(this._module_source_map.has(module)) {
							source.sourceReference = <number>this._module_source_map.get(module);
						} else {
							source.sourceReference = this._source_id;
							this._module_source_map.set(module, this._source_id);
							this._source_module_map.set(this._source_id, module);
							this._source_id++;
						}
					}

					let stackframe = new StackFrame(id, fn_name, source, this.convertDebuggerLineToClient(line));
					frames.push(stackframe);

					match_results = frame_match.exec(msg);
				}

				let response = this._stack_response_queue.shift();

				if(!response) {
					logger.error("Got a stack event without corresponding response in queue!");
					return;
				}

				response.body = {
					stackFrames: frames.reverse(), //wren prints the stack out in order of increasing depth, vscode wants decreasing order
					totalFrames: frames.length
				}

				this.sendResponse(response);
			}

			this._response_events.on("stack", stack_handler);
		}

		{
			let source_handler = (msg:string) => {
				let response = this._source_response_queue.shift();
				if(!response) {
					logger.error("Got source event without corresponding response in queue!");
					return;
				}

				if(!response.body) {
					response.body = {content: ""};
				}
				response.body.content = msg;
				this.sendResponse(response);
			}

			this._response_events.on("source", source_handler);
		}

		{
			let module_vars_handler = (msg:string) => {

				let response = this._variables_response_queue.shift();
				if(!response) {
					logger.error("Got module vars event without corresponding response in queue!");
					return;
				}

				let variables = new Array<DebugProtocol.Variable>();

				while(msg.length > 0) {
					let match_results = msg.match(/(\w+)\|(\w+)\|(\d+)\|/);
					if(match_results) {
						let var_name = match_results[1];
						let type_name = match_results[2];
						let printed_len = Number(match_results[3]);

						let printed_val = msg.substr(<number>match_results.index + match_results[0].length, printed_len);

						variables.push({
							name: var_name,
							type: type_name,
							value: printed_val,
							variablesReference: 0
						});

						msg = msg.substring(<number>match_results.index + match_results[0].length + printed_len + 1); //rest of message after the \n for this var
					}
				}

				response.body = {
					variables: variables
				};

				this.sendResponse(response);
			}

			this._response_events.on("vars", module_vars_handler);
		}
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
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
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		//this._configurationDone.notify(); //:todo: launch and attach
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		// await this._configurationDone.wait(1000);

		// start the program in the runtime
		// this._runtime.start(args.program, !!args.stopOnEntry);

		this.sendResponse(response);
	}


	protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {
		this._projectRoot = args.projectRoot;

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		this._socket = createConnection(8089, "127.0.0.1", () => {
			this.sendEvent(new InitializedEvent());
		})

		this._socket.on('error', (error) => {
			logger.error('failed to connect socket (${error})');
			//No need to send termianted since we always get a closed event at the end
		});

		this._socket.on('close', () => {
			logger.log('socket closed');
			this.sendEvent(new TerminatedEvent());
		});

		this._socket.on("connect" , () => {
			logger.log("socket opened!");
			console.log("socket connected!");
		});

		this._socket.on('data', (data:Buffer) => {
			let msg = data.toString();
			console.log("debug `" + msg + "`");
			logger.log(msg, Logger.LogLevel.Verbose);
			while(msg.length > 0) {
				let new_msg = this.process_response_data(msg);
				if(new_msg === msg) {
					logger.error("No change to the message after trying to process it! Stopping the process loop.");
					break;
				} else {
					msg = new_msg;
				}
			}
		});

		this.sendResponse(response);
	}

	private _event_payload = "";
	private _event_type:number = -1
	private _payload_length:number = -1;
	private _event_final:number = -1;

	protected process_response_data(msg:string):string {
		if(this._event_type === -1) {
			let match_results = msg.match(/event: (\d+)\n/);

			if(match_results) {
				let event_type = <ResponseEventType>Number(match_results[1]);
				this._event_type = event_type;

				msg = msg.substring(<number>match_results.index + match_results[0].length);
			}
		}

		if(this._payload_length === -1) {
			let match_results = msg.match(/length: (\d+)\n/);
			if(match_results) {
				let length = Number(match_results[1]);
				this._payload_length = length;
				msg = msg.substring(<number>match_results.index + match_results[0].length);
			}
		}


		if(this._event_final === -1) {
			let match_results = msg.match(/final: (\d)\n/);
			if(match_results) {
				let final = Number(match_results[1]);
				this._event_final = final;
				msg = msg.substring(<number>match_results.index + match_results[0].length);
			}
		}

		if(this._payload_length !== -1) {
			let add_len = msg.length < this._payload_length ? msg.length : this._payload_length;

			this._event_payload += msg.substring(0, add_len);
			this._payload_length -= add_len;
			msg = msg.substring(add_len);

			if(this._payload_length === 0) {

				if(this._event_final === 1) {

					let event_name = <string>this._response_event_names.get(<ResponseEventType>this._event_type); //:todo: why not go just by event type number?

					this._response_events.emit(event_name, this._event_payload);

					this._event_payload = "";
				}

				this._event_type = -1;
				this._payload_length = -1
				this._event_final = -1
			}
		}

		return msg;
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
			//remove all breakpoints and set the program going again so it doesn't get stuck from disconnecting
		this._breakpoints.forEach((value: WrenBreakpoint[], key: string) => {
			this.clearBreakpoints(key, value);
		})
		this._socket.write("cont\n");
		this._socket.end();
		this.sendResponse(response);
	}

	protected clearBreakpoints(module:string, breakpoints:Array<WrenBreakpoint>) {
		for(let breakpoint of breakpoints) {
			this._socket.write("delp " + module + " " + breakpoint.line + "\n");
		}
		breakpoints.length = 0;
	}

	//:todo: obviously but this is annoying.
	private actually_normalize(path: string): string {
		let result = normalize(path);
				result = result.replace(/\\\\/g, '/');
				result = result.replace(/\\/g, '/');
		return result;
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		let root = this.actually_normalize(this._projectRoot);
		let source = this.actually_normalize(<string>args.source.path);
		let module = relative(root, source);
				module = join(dirname(module), basename(module, ".wren"));
		module = this.actually_normalize(module);
		console.log("adding breaking to `"+module+"`")
		let breakpoints = this._breakpoints.get(module);
		if(breakpoints) {
			this.clearBreakpoints(module, breakpoints);
		} else {
			breakpoints = new Array<WrenBreakpoint>();
			this._breakpoints.set(module, breakpoints);
		}

		const argBreakpoints = args.breakpoints || [];


		if(argBreakpoints.length !== 0) { // do not add a request in the queue if we won't send anything that we'll get a response from the debugger for
			this._set_breakpoint_queue.push({module: module, breakpoints: argBreakpoints, response: response});

			for(let breakpoint of argBreakpoints) {
				var cmd = "addp " + module + " " + breakpoint.line + "\n";
				this._socket.write(cmd, function (){
					console.log(arguments.length);
				});
			}
		}
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports now threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(WrenDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		this._stack_response_queue.push(response);

		let root = this.actually_normalize(this._projectRoot);
		this._socket.write("stack \"" + root +"\"\n");
	}

	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments): void {

		let ref = <number>(args.source ? args.source.sourceReference : args.sourceReference);

		let module_name = this._source_module_map.get(ref);

		if(module_name) {
			this._source_response_queue.push(response);
			this._socket.write("source \"" + module_name + "\"");
		} else {
			logger.warn("No module name known for source reference " + ref);
		}
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		const frameReference = args.frameId;
		logger.log("Scopes for frame: " + frameReference);
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Module", this._variableHandles.create("module_" + frameReference), false));
		scopes.push(new Scope("Function", this._variableHandles.create("function_" + frameReference), false));

		response.body = {
			scopes: scopes
		};

		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

		const ref_str = this._variableHandles.get(args.variablesReference);

		if(ref_str !== null) {
				//:todo; this is overkill, could just make handle ids match cmd syntax
			let match_results = ref_str.match(/(module|function)_(\d+)/);
			if(match_results) {
				let section = match_results[1];
				let stack_idx = Number(match_results[2]) - 1; //convert from vscode stack references (start at 1) to wren debugger ones (start at 0)
				this._variables_response_queue.push(response);
				this._socket.write("info " + section + " " + stack_idx + "\n");
			}
		}
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._socket.write("cont\n");
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		// this._runtime.step();
		this._socket.write("over\n");
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this._socket.write("into\n");
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this._socket.write("out\n");
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		// response.body = {
		// 	result: `evaluate(context: '${args.context}', '${args.expression}')`,
		// 	variablesReference: 0
		// };
		this.sendResponse(response);
	}
}