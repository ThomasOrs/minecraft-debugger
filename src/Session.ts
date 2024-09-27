// Copyright (C) Microsoft Corporation.  All rights reserved.

import { createConnection, Server, Socket } from 'net';
import {
    DebugSession,
    InitializedEvent,
    Scope,
    Source,
    StackFrame,
    StoppedEvent,
    TerminatedEvent,
    Thread,
    ThreadEvent,
    Variable,
} from '@vscode/debugadapter';
import {
    commands,
    FileSystemWatcher,
    InputBoxOptions,
    QuickPickItem,
    QuickPickOptions,
    workspace,
    window,
    debug,
} from 'vscode';
import { DebugProtocol } from '@vscode/debugprotocol';
import { EventEmitter } from 'events';
import { LogOutputEvent, LogLevel } from '@vscode/debugadapter/lib/logger';
import { MessageStreamParser } from './MessageStreamParser';
import { SourceMaps } from './SourceMaps';
import { StatMessageModel, StatsProvider2 } from './StatsProvider2';
import * as path from 'path';
import * as fs from 'fs';
import { isUUID } from './Utils';

interface PendingResponse {
    onSuccess?: Function;
    onFail?: Function;
}

// Module mapping for getting line numbers for a given module
interface ModuleMapping {
    [moduleName: string]: string;
}

interface PluginDetails {
    name: string;
    module_uuid: string;
}

interface ProtocolCapabilities {
    type: string;
    version: number;
    plugins: PluginDetails[];
    require_passcode?: boolean;
}

// Interface for specific launch arguments.
// See package.json for schema.
interface IAttachRequestArguments extends DebugProtocol.AttachRequestArguments {
    mode?: string;
    localRoot?: string;
    generatedSourceRoot?: string;
    sourceMapRoot?: string;
    inlineSourceMap?: boolean;
    host?: string;
    port?: number;
    inputPort?: string;
    moduleMapping?: ModuleMapping;
    sourceMapBias?: string;
    targetModuleUuid?: string;
    passcode?: string;
}

class TargetPluginItem implements QuickPickItem {
    public label: string;
    public detail: string;
    public targetModuleId: string;

    constructor(pluginDetails: PluginDetails) {
        this.label = pluginDetails.name;
        this.detail = 'Script module uuid ' + pluginDetails.module_uuid;
        this.targetModuleId = pluginDetails.module_uuid;
    }
}

// protocol version history
// 1 - initial version
// 2 - add targetModuleUuid to protocol event
// 3 - add array of plugins and target module ids to incoming protocol event
// 4 - mc can require a passcode to connect
enum ProtcolVersion {
    Initial = 1,
    SupportTargetModuleUuid = 2,
    SupportTargetSelection = 3,
    SupportPasscode = 4,
}

// The Debug Adapter for 'minecraft-js'
//
export class Session extends DebugSession {
    private static DEBUGGER_PROTOCOL_VERSION = ProtcolVersion.SupportPasscode;

    private static CONNECTION_RETRY_ATTEMPTS = 5;
    private static CONNECTION_RETRY_WAIT_MS = 2000;

    private _debugeeServer?: Server; // when listening for incoming connections
    private _connectionSocket?: Socket;
    private _terminated: boolean = false;
    private _threads = new Set<number>();
    private _requests = new Map<number, PendingResponse>();
    private _sourceMaps: SourceMaps = new SourceMaps('');
    private _fileWatcher?: FileSystemWatcher;
    private _activeThreadId: number = 0; // the one being debugged
    private _localRoot: string = '';
    private _sourceMapRoot?: string;
    private _generatedSourceRoot?: string;
    private _inlineSourceMap: boolean = false;
    private _moduleMapping?: ModuleMapping;
    private _sourceMapBias?: string;
    private _targetModuleUuid?: string;
    private _passcode?: string;
    private _statsProvider: StatsProvider2;
    private _eventEmitter: any;

    public constructor(statsProvider: StatsProvider2, eventEmitter: EventEmitter) {
        super();

        this._statsProvider = statsProvider;
        this._eventEmitter = eventEmitter;

        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);

        // listen for events from the HomeViewProvider
        this._eventEmitter.on('run-minecraft-command', (command: string) => {
            if (!debug.activeDebugSession) {
                window.showErrorMessage('Command shortcuts require a debug session.');
                return;
            }
            this.sendDebuggeeMessage({
                type: 'minecraftCommand',
                command: command,
                dimension_type: 'overworld', // todo: get this from the user
            });
        });
    }

    // ------------------------------------------------------------------------
    // VSCode to Debug Adapter requests
    // ------------------------------------------------------------------------

    // VSCode extension has been activated due to the 'onDebug' activation request defined in packages.json
    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments
    ): void {
        const capabilities: DebugProtocol.Capabilities = {
            // indicates VSCode should send the configurationDoneRequest
            supportsConfigurationDoneRequest: true,
            // additional breakpoint filter options shown in UI
            exceptionBreakpointFilters: [
                {
                    filter: 'exceptions',
                    label: 'All Exceptions',
                    default: false,
                },
            ],
        };

        response.body = capabilities;

        // send config response back to VSCode
        this.sendResponse(response);
    }

    // VSCode starts MC exe, then waits for MC to boot and connect back to a listening VSCode
    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: DebugProtocol.LaunchRequestArguments,
        request?: DebugProtocol.Request
    ) {
        // not implemented
    }

    // VSCode wants to attach to a debugee (MC), create socket connection on specified port
    protected async attachRequest(
        response: DebugProtocol.AttachResponse,
        args: IAttachRequestArguments,
        request?: DebugProtocol.Request
    ) {
        this.closeSession();

        this.resolveEnvironmentVariables(args);

        const host = args.host || 'localhost';
        let port = args.port || (args.inputPort ? parseInt(args.inputPort) : NaN);
        if (isNaN(port)) {
            this.sendErrorResponse(response, 1001, `Failed to attach to Minecraft, invalid port "${args.inputPort}".`);
            return;
        }
        if (args.targetModuleUuid && isUUID(args.targetModuleUuid)) {
            this._targetModuleUuid = args.targetModuleUuid.toLowerCase();
        }
        this._passcode = args.passcode;

        this._localRoot = args.localRoot ? path.normalize(args.localRoot) : '';
        this._sourceMapRoot = args.sourceMapRoot ? path.normalize(args.sourceMapRoot) : undefined;
        this._generatedSourceRoot = args.generatedSourceRoot ? path.normalize(args.generatedSourceRoot) : undefined;
        this._inlineSourceMap = args.inlineSourceMap ? args.inlineSourceMap : false;
        this._moduleMapping = args.moduleMapping;
        this._sourceMapBias = args.sourceMapBias;

        // Listen or connect (default), depending on mode.
        // Attach makes more sense to use connect, but some MC platforms require using listen.
        try {
            if (args.mode === 'listen') {
                await this.listen(port);
            } else {
                await this.connect(host, port);
            }
        } catch (e) {
            this.log((e as Error).message, LogLevel.Error);
            this.sendErrorResponse(response, 1004, `Failed to attach debugger to Minecraft.`);
            return;
        }

        // tell VSCode that attach has been received
        this.sendResponse(response);
    }

    protected resolveEnvironmentVariables(args: IAttachRequestArguments) {
        const localAppDataDir = process.env.LOCALAPPDATA || '';

        for (const key of Object.keys(args)) {
            //if the value is a string and starts with %localappdata%, replace it with the actual path to AppData\Local
            let value = args[key as keyof IAttachRequestArguments];
            if (typeof value === 'string' && value.toLowerCase().startsWith('%localappdata%')) {
                (args as any)[key] = path.join(localAppDataDir, value.substring('%localappdata%'.length));
            }
        }
    }

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments,
        request?: DebugProtocol.Request
    ) {
        response.body = {
            breakpoints: [],
        };

        if (!args.source.path) {
            this.sendResponse(response);
            return;
        }

        let originalLocalAbsolutePath = path.normalize(args.source.path);

        const originalBreakpoints = args.breakpoints || [];
        const generatedBreakpoints: DebugProtocol.SourceBreakpoint[] = [];
        let generatedRemoteLocalPath = undefined;

        try {
            // first get generated remote file path, will throw if fails
            generatedRemoteLocalPath = await this._sourceMaps.getGeneratedRemoteRelativePath(originalLocalAbsolutePath);

            // for all breakpoint positions set on the source file, get generated/mapped positions
            if (originalBreakpoints.length) {
                for (let originalBreakpoint of originalBreakpoints) {
                    const generatedPosition = await this._sourceMaps.getGeneratedPositionFor({
                        source: originalLocalAbsolutePath,
                        column: originalBreakpoint.column || 0,
                        line: originalBreakpoint.line,
                    });
                    generatedBreakpoints.push({
                        line: generatedPosition.line || 0,
                        column: 0,
                    });
                }
            }
        } catch (e) {
            this.log((e as Error).message, LogLevel.Error);
            this.sendErrorResponse(response, 1002, `Failed to resolve breakpoint for ${originalLocalAbsolutePath}.`);
            return;
        }

        const envelope = {
            type: 'breakpoints',
            breakpoints: {
                path: generatedRemoteLocalPath,
                breakpoints: generatedBreakpoints.length ? generatedBreakpoints : undefined,
            },
        };

        this.sendDebuggeeMessage(envelope);
        this.sendResponse(response);
    }

    protected setExceptionBreakPointsRequest(
        response: DebugProtocol.SetExceptionBreakpointsResponse,
        args: DebugProtocol.SetExceptionBreakpointsArguments,
        request?: DebugProtocol.Request
    ): void {
        this.sendDebuggeeMessage({
            type: 'stopOnException',
            stopOnException: args.filters.length > 0, // there's only 1 type for now so no need to look at which one it is
        });

        this.sendResponse(response);
    }

    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments,
        request?: DebugProtocol.Request
    ): void {
        this.sendDebuggeeMessage({
            type: 'resume',
        });

        this.sendResponse(response);
    }

    // VSCode wants current threads (substitute JS contexts)
    protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void {
        response.body = {
            threads: Array.from(this._threads.keys()).map(
                thread => new Thread(thread, `thread 0x${thread.toString(16)}`)
            ),
        };
        this.sendResponse(response);
    }

    // VSCode requesting stack trace for threads, follows threadsRequest
    protected async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): Promise<void> {
        const threadId = args.threadId;
        const stacksBody = await this.sendDebugeeRequestAsync(threadId, response, args);

        this._activeThreadId = threadId;

        const stackFrames: StackFrame[] = [];
        for (const { id, name, filename, line, column } of stacksBody) {
            const mappedFilename = this._moduleMapping?.[filename] ?? filename;
            try {
                const originalLocation = await this._sourceMaps.getOriginalPositionFor({
                    source: mappedFilename,
                    line: line || 0,
                    column: column || 0,
                });
                const source = new Source(path.basename(originalLocation.source), originalLocation.source);
                stackFrames.push(new StackFrame(id, name, source, originalLocation.line, originalLocation.column));
            } catch (e) {
                stackFrames.push(new StackFrame(id, name));
            }
        }

        const totalFrames = stacksBody.length;

        response.body = {
            stackFrames,
            totalFrames,
        };

        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
        // get scopes from debugee for this frame, args contains the desired stack frame id
        this.sendDebugeeRequest(this._activeThreadId, response, args, (body: any) => {
            const scopes: Scope[] = [];
            for (const { name, reference, expensive } of body) {
                scopes.push(new Scope(name, reference, expensive));
            }
            response.body = {
                scopes,
            };
            this.sendResponse(response);
        });
    }

    protected variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments,
        request?: DebugProtocol.Request
    ) {
        // get variables at this reference (all vars in scope or vars in object/array)
        this.sendDebugeeRequest(this._activeThreadId, response, args, (body: any) => {
            const variables: Variable[] = [];
            for (const { name, value, type, variablesReference, indexedVariables } of body) {
                // if variablesReference is non-zero then it represents an object and will trigger additional variablesRequests when expanded by user
                let variable: DebugProtocol.Variable = new Variable(name, value, variablesReference, indexedVariables);
                variable.type = type; // to show type when hovered
                variables.push(variable);
            }
            response.body = {
                variables,
            };
            this.sendResponse(response);
        });
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
        this.sendDebugeeRequest(this._activeThreadId, response, args, (body: any) => {
            response.body = body;
            this.sendResponse(response);
        });
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
        this.sendDebugeeRequest(args.threadId, response, args, (body: any) => {
            response.body = body;
            this.sendResponse(response);
        });
    }

    protected pauseRequest(
        response: DebugProtocol.PauseResponse,
        args: DebugProtocol.PauseArguments,
        request?: DebugProtocol.Request
    ) {
        this.sendDebugeeRequest(args.threadId, response, args, (body: any) => {
            response.body = body;
            this.sendResponse(response);
        });
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
        this.sendDebugeeRequest(args.threadId, response, args, (body: any) => {
            response.body = body;
            this.sendResponse(response);
        });
    }

    protected stepInRequest(
        response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments,
        request?: DebugProtocol.Request
    ) {
        this.sendDebugeeRequest(args.threadId, response, args, (body: any) => {
            response.body = body;
            this.sendResponse(response);
        });
    }

    protected stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        args: DebugProtocol.StepOutArguments,
        request?: DebugProtocol.Request
    ) {
        this.sendDebugeeRequest(args.threadId, response, args, (body: any) => {
            response.body = body;
            this.sendResponse(response);
        });
    }

    protected disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments,
        request?: DebugProtocol.Request
    ): void {
        // closeSession triggers the 'close' event on the socket which will call terminateSession
        this.closeServer();
        this.closeSession();
        this.sendResponse(response);
    }

    // ------------------------------------------------------------------------
    // Session Setup
    // ------------------------------------------------------------------------

    // listen for Minecraft connections (VSCode is the server, Minecraft (debugee) is client)
    private async listen(port: number) {
        this._debugeeServer = new Server(socket => {
            this.closeServer();
            this.onDebugeeConnected(socket);
        });
        this._debugeeServer.listen(port);
        this.showNotification(`Listening for debugger connections on port [${port}].`, LogLevel.Log);
    }

    // connect to Minecraft (Minecraft (debugee) is server, VSCode is client)
    private async connect(host: string, port: number) {
        let socket: Socket | undefined = undefined;

        // try connecting for 5 seconds
        for (let attempt = 0; attempt < Session.CONNECTION_RETRY_ATTEMPTS; attempt++) {
            this.log(`Connecting to host [${host}] on port [${port}], attempt [${attempt + 1}].`, LogLevel.Log);
            try {
                socket = await new Promise<Socket>((resolve, reject) => {
                    let client = createConnection({ host: host, port: port });
                    client.on('connect', () => {
                        client.removeAllListeners();
                        resolve(client);
                    });

                    client.on('close', reject);
                    client.on('error', reject);
                });
                break;
            } catch (e) {
                await new Promise(resolve => setTimeout(resolve, Session.CONNECTION_RETRY_WAIT_MS));
            }
        }

        if (!socket) {
            this.terminateSession('failed to connect debugger');
            throw new Error(`Failed to connect to host [${host}] on port [${port}].`);
        }

        this.onDebugeeConnected(socket);
    }

    private onDebugeeConnected(socket: Socket) {
        this._connectionSocket = socket;

        // create socket stream parser and setup event handlers
        let socketStreamParser = new MessageStreamParser();
        socketStreamParser.on('message', (envelope: any) => {
            this.receiveDebugeeMessage(envelope);
        });

        // set socket event handlers
        socket.on('error', e => {
            this.terminateSession(e.toString());
        });
        socket.on('close', () => {
            this.terminateSession('socket closed');
        });

        // connect socket to stream parser
        socket.pipe(socketStreamParser as any);

        //
        // Now wait for the debugee protocol event which will call onConnectionComplete if accepted.
        //
    }

    private onConnectionComplete(protocolVersion?: number, targetModuleUuid?: string, passcode?: string) {
        this._targetModuleUuid = targetModuleUuid;

        // respond with protocol version and chosen debugee target
        this.sendDebuggeeMessage({
            type: 'protocol',
            version: protocolVersion,
            target_module_uuid: targetModuleUuid,
            passcode: passcode,
        });

        // show notifications for source map issues
        this.checkSourceFilePaths();

        // success
        this.showNotification('Success! Debugger is now connected.', LogLevel.Log);

        // init source maps
        this._sourceMaps = new SourceMaps(
            this._localRoot,
            this._sourceMapRoot,
            this._generatedSourceRoot,
            this._inlineSourceMap,
            this._sourceMapBias
        );

        // watch for source map changes
        this.createSourceMapFileWatcher(this._sourceMapRoot);

        // Now that a connection is established, and capabilities have been delivered, send this event to
        // tell VSCode to ask Minecraft/debugee for config data (breakpoints etc).
        // When config is complete VSCode calls 'configurationDoneRequest' and the DA
        // sends a 'resume' message to the debugee, which had paused following the attach.
        this.sendEvent(new InitializedEvent());

        // If the user has set the configuration to show the diagnostic view on connect in settings.json, show it now.
        if (workspace.getConfiguration('minecraft-debugger').get('showDiagnosticViewOnConnect')) {
            commands.executeCommand('minecraft-debugger.showMinecraftDiagnostics');
        }
    }

    // stop listening for connections
    private closeServer() {
        if (this._debugeeServer) {
            this._debugeeServer.close();
        }
        this._debugeeServer = undefined;
    }

    // close connection to debugee (MC)
    private closeSession() {
        if (this._connectionSocket) {
            this._connectionSocket.destroy();
        }
        this._connectionSocket = undefined;

        if (this._fileWatcher) {
            this._fileWatcher.dispose();
            this._fileWatcher = undefined;
        }
    }

    // close and terminate session (could be from debugee request)
    // send terminated event to VSCode to release DA
    private terminateSession(reason: string, logLevel: LogLevel = LogLevel.Log) {
        this.closeServer();
        this.closeSession();

        if (!this._terminated) {
            this._terminated = true;
            this.sendEvent(new TerminatedEvent());

            this.showNotification(`Session terminated, ${reason}.`, logLevel);
        }
    }

    // ------------------------------------------------------------------------
    // Debugee message send and receive
    // ------------------------------------------------------------------------

    // async send message of type 'request' with promise and await results.
    private sendDebugeeRequestAsync(thread: number, response: DebugProtocol.Response, args: any): Promise<any> {
        let promise = new Promise((resolve, reject) => {
            let requestSeq = response.request_seq;
            this._requests.set(requestSeq, {
                onSuccess: resolve,
                onFail: reject,
            });

            this.sendDebuggeeMessage(this.makeRequestPayload(requestSeq, response.command, args));
        });
        return promise;
    }

    // send message of type 'request' and callback with results.
    private sendDebugeeRequest(thread: number, response: DebugProtocol.Response, args: any, callback: Function) {
        let requestSeq = response.request_seq;
        this._requests.set(requestSeq, {
            onSuccess: callback,
            onFail: undefined,
        });

        this.sendDebuggeeMessage(this.makeRequestPayload(requestSeq, response.command, args));
    }

    private makeRequestPayload(requestSeq: number, responseCommand: string, args: any) {
        let envelope = {
            type: 'request',
            request: {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                request_seq: requestSeq,
                command: responseCommand,
                args,
            },
        };
        return envelope;
    }

    private sendDebuggeeMessage(envelope: any) {
        if (!this._connectionSocket) {
            return;
        }

        let json = JSON.stringify(envelope);
        let jsonBuffer = Buffer.from(json);
        // length prefix is 8 hex followed by newline = 012345678\n
        // not efficient, but protocol is then human readable.
        // json = 1 line json + new line
        let messageLength = jsonBuffer.byteLength + 1;
        let length = '00000000' + messageLength.toString(16) + '\n';
        length = length.substring(length.length - 9);
        let lengthBuffer = Buffer.from(length);
        let newline = Buffer.from('\n');
        let buffer = Buffer.concat([lengthBuffer, jsonBuffer, newline]);

        this._connectionSocket.write(buffer);
    }

    private receiveDebugeeMessage(envelope: any) {
        if (envelope.type === 'event') {
            this.handleDebugeeEvent(envelope.event);
        } else if (envelope.type === 'response') {
            this.handleDebugeeResponse(envelope);
        }
    }

    // Debugee (MC) has sent an event.
    private handleDebugeeEvent(eventMessage: any) {
        if (eventMessage.type === 'StoppedEvent') {
            this.trackThreadChanges(eventMessage.reason, eventMessage.thread);
            this.sendEvent(new StoppedEvent(eventMessage.reason, eventMessage.thread));
        } else if (eventMessage.type === 'ThreadEvent') {
            this.trackThreadChanges(eventMessage.reason, eventMessage.thread);
            this.sendEvent(new ThreadEvent(eventMessage.reason, eventMessage.thread));
        } else if (eventMessage.type === 'PrintEvent') {
            this.handlePrintEvent(eventMessage.message, eventMessage.logLevel);
        } else if (eventMessage.type === 'NotificationEvent') {
            this.showNotification(eventMessage.message, eventMessage.logLevel);
        } else if (eventMessage.type === 'ProtocolEvent') {
            this.handleProtocolEvent(eventMessage as ProtocolCapabilities);
        } else if (eventMessage.type === 'StatEvent2') {
            this._statsProvider.setStats(eventMessage as StatMessageModel);
        }
    }

    private async handlePrintEvent(message: string, logLevel: LogLevel) {
        // Attempt to resolve type maps for file paths/line numbers in each message
        const jsFileLineNoColumRegex = /\(([a-zA-Z0-9_\-./\\ ]+\.js):(\d+)\)/g;
        let matches = message.matchAll(jsFileLineNoColumRegex);
        for (const match of matches) {
            try {
                const fullMatch = match[0];
                const javaScriptFilePath = match[1];
                const javaScriptLineNumber = parseInt(match[2]);

                const generatedPosition = await this._sourceMaps.getOriginalPositionFor({
                    source: javaScriptFilePath,
                    column: 0,
                    line: javaScriptLineNumber,
                });
                // Resolve generatedPosition.source to be relative to the active workspace. If there is no workspace, the absolute path gets returned.
                let generatedPositionSourceAsRelative = workspace.asRelativePath(generatedPosition.source);
                if (generatedPositionSourceAsRelative !== generatedPosition.source) {
                    generatedPositionSourceAsRelative = `./${generatedPositionSourceAsRelative}`;
                }

                if (generatedPosition) {
                    message = message.replace(
                        fullMatch,
                        `(${generatedPositionSourceAsRelative}:${generatedPosition.line}) (${javaScriptFilePath}:${javaScriptLineNumber})`
                    );
                }
            } catch (e) {
                // Eat the error, sometimes source map lookups just ain't happening
            }
        }

        this.sendEvent(new LogOutputEvent(message.trimEnd() + '\n', logLevel));
    }
    // Debugee (MC) responses to pending VSCode requests. Promises contained in a map keyed by
    // the sequence number of the request. Fascilitates the 'await sendDebugeeRequestAsync(...)' pattern.
    private handleDebugeeResponse(envelope: any) {
        let requestSeq: number = envelope.request_seq;
        let pending = this._requests.get(requestSeq);
        if (!pending) {
            return;
        }

        // release the request
        this._requests.delete(requestSeq);

        if (envelope.error) {
            if (pending.onFail) {
                pending.onFail(new Error(envelope.error));
            }
            this.log(`Debugee response error: ${envelope.error}`, LogLevel.Error);
        } else {
            if (pending.onSuccess) {
                pending.onSuccess(envelope.body);
            }
        }
    }

    // ------------------------------------------------------------------------

    // the final client event before connection is complete
    private async handleProtocolEvent(protocolCapabilities: ProtocolCapabilities): Promise<void> {
        //
        // handle protocol capabilities here...
        // can fail connection on errors
        //
        if (Session.DEBUGGER_PROTOCOL_VERSION < protocolCapabilities.version) {
            this.terminateSession('protocol mismatch. Update Debugger Extension.', LogLevel.Error);
        } else {
            if (protocolCapabilities.version == ProtcolVersion.SupportTargetModuleUuid) {
                this.onConnectionComplete(protocolCapabilities.version, undefined);
            } else if (protocolCapabilities.version >= ProtcolVersion.SupportTargetSelection) {
                // no add-ons found, nothing to do
                if (!protocolCapabilities.plugins || protocolCapabilities.plugins.length === 0) {
                    this.terminateSession('protocol error. No Minecraft Add-Ons found.', LogLevel.Error);
                    return;
                }

                // if passcode is required, prompt user for it
                let passcode = await this.promptForPasscode(protocolCapabilities.require_passcode);

                // if a targetuuid was provided, make sure it's valid
                if (this._targetModuleUuid) {
                    const isValidTarget = protocolCapabilities.plugins.some(
                        plugin => plugin.module_uuid === this._targetModuleUuid
                    );
                    if (isValidTarget) {
                        this.onConnectionComplete(protocolCapabilities.version, this._targetModuleUuid, passcode);
                        return;
                    } else {
                        this.showNotification(
                            `Minecraft Add-On script module not found with targetModuleUuid ${this._targetModuleUuid} specified in launch.json. Prompting for debug target.`,
                            LogLevel.Warn
                        );
                    }
                } else if (protocolCapabilities.plugins.length === 1) {
                    this.onConnectionComplete(
                        protocolCapabilities.version,
                        protocolCapabilities.plugins[0].module_uuid,
                        passcode
                    );
                    return;
                } else {
                    this.showNotification(
                        'The targetModuleUuid in launch.json is not set to a valid uuid. Set this to a script module uuid (manifest.json) to avoid the selection prompt.',
                        LogLevel.Warn
                    );
                }

                // Could not connect automatically, prompt user to select target.
                const targetUuid = await this.promptForTargetPlugin(protocolCapabilities.plugins);
                if (!targetUuid) {
                    this.terminateSession(
                        'could not determine target Minecraft Add-On. You must specify the targetModuleUuid.',
                        LogLevel.Error
                    );
                    return;
                }
                this.onConnectionComplete(protocolCapabilities.version, targetUuid, passcode);
            } else {
                this.terminateSession('protocol unsupported. Update Debugger Extension.', LogLevel.Error);
            }
        }
    }

    private async promptForPasscode(requirePasscode?: boolean): Promise<string | undefined> {
        if (requirePasscode) {
            if (this._passcode) {
                return this._passcode;
            } else {
                const options: InputBoxOptions = {
                    title: 'Enter Passcode',
                    ignoreFocusOut: true,
                };
                return await window.showInputBox(options);
            }
        }
        return undefined;
    }

    private async promptForTargetPlugin(plugins: PluginDetails[]): Promise<string | undefined> {
        const items: TargetPluginItem[] = plugins.map(plugin => new TargetPluginItem(plugin));
        const options: QuickPickOptions = {
            title: 'Choose the Minecraft Add-On to debug',
            ignoreFocusOut: true,
        };
        const targetItem = await window.showQuickPick(items, options);
        if (targetItem) {
            return targetItem.targetModuleId;
        }
        return undefined;
    }

    // check that source and map properties in launch.json are set correctly
    private checkSourceFilePaths() {
        if (this._sourceMapRoot) {
            const foundMaps = this._inlineSourceMap ? true : this.doFilesWithExtExistAt(this._sourceMapRoot, ['.map']);
            if (!foundMaps) {
                this.showNotification(
                    "Failed to find source maps, check that launch.json 'sourceMapRoot' contains .map files.",
                    LogLevel.Warn
                );
            }
            const foundJS = this.doFilesWithExtExistAt(this._sourceMapRoot, ['.js']);
            if (!foundJS) {
                const foundGeneratedJS = this.doFilesWithExtExistAt(this._generatedSourceRoot, ['.js']);
                if (!foundGeneratedJS) {
                    this.showNotification(
                        "Failed to find generated .js files. Check that launch.json 'sourceMapRoot' or alternately 'generatedSourceRoot' cointain .js files.",
                        LogLevel.Warn
                    );
                }
            }
        } else {
            const foundJS = this.doFilesWithExtExistAt(this._localRoot, ['.js']);
            if (!foundJS) {
                this.showNotification(
                    "Failed to find .js files. Check that launch.json 'localRoot' cointains .js files.",
                    LogLevel.Warn
                );
            }
        }
    }

    private doFilesWithExtExistAt(filePath?: string, extensions?: string[]) {
        if (!filePath || !extensions) {
            return false;
        }
        try {
            let fileNames = fs.readdirSync(filePath, { encoding: null, recursive: true });
            for (let fn of fileNames) {
                if (extensions.some(ext => fn.endsWith(ext))) {
                    return true;
                }
            }
        } catch (e) {
            this.log((e as Error).message, LogLevel.Error);
        }
        return false;
    }

    private trackThreadChanges(reason: string, threadId: number) {
        if (reason === 'exited') {
            this._threads.delete(threadId);
        } else {
            this._threads.add(threadId);
        }
    }

    private createSourceMapFileWatcher(sourceMapRoot?: string) {
        if (this._fileWatcher) {
            this._fileWatcher.dispose();
            this._fileWatcher = undefined;
        }
        if (sourceMapRoot) {
            this._fileWatcher = workspace.createFileSystemWatcher('**/*.{map}', false, false, false);
            this._fileWatcher.onDidChange(uri => {
                this._sourceMaps.reset();
            });
            this._fileWatcher.onDidCreate(uri => {
                this._sourceMaps.reset();
            });
            this._fileWatcher.onDidDelete(uri => {
                this._sourceMaps.reset();
            });
        }
    }

    // ------------------------------------------------------------------------

    private log(message: string, logLevel: LogLevel) {
        this.sendEvent(new LogOutputEvent(message + '\n', logLevel));
    }

    private showNotification(message: string, logLevel: LogLevel) {
        if (logLevel === LogLevel.Log) {
            window.showInformationMessage(message);
        } else if (logLevel === LogLevel.Warn) {
            window.showWarningMessage(message);
        } else if (logLevel === LogLevel.Error) {
            window.showErrorMessage(message);
        }
    }
}
