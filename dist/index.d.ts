interface Task {
    id: string;
    wasmModule: ArrayBuffer;
    input: any;
    timeoutMs: number;
}
interface WorkUnit {
    id: string;
    taskId: string;
    wasmModule: ArrayBuffer;
    input: any;
}
interface TaskResult {
    taskId: string;
    result: any;
    error?: string;
    executionTimeMs: number;
}
interface WorkUnitResult {
    workUnitId: string;
    taskId: string;
    result: any;
    error?: string;
    executionTimeMs: number;
}

type Callback = (...args: any[]) => void;
declare class EventEmitter {
    private listeners;
    on(event: string, cb: Callback): void;
    emit(event: string, ...args: any[]): void;
    off(event: string, cb: Callback): void;
}

declare class SwarmCompute extends EventEmitter {
    private client;
    private workerPool;
    private taskScheduler;
    private peerTransport;
    private session;
    private joining;
    private p2pTaskResolvers;
    constructor(options?: any);
    submitTask(wasmModule: ArrayBuffer, input: any): Promise<TaskResult>;
    joinSwarm(): Promise<void>;
    leaveSwarm(): Promise<void>;
    private isCurrentSession;
    private disconnectedError;
    private processTask;
    get workerCount(): number;
    get isWorker(): boolean;
}

declare class CoordinatorClient extends EventEmitter {
    private ws;
    private url;
    private isMobile;
    constructor(url: string);
    connect(): void;
    send(data: any): void;
    hasConnection(): boolean;
    disconnect(): void;
    getIsMobile(): boolean;
}

declare class TaskScheduler {
    private client;
    private pending;
    constructor(client: CoordinatorClient);
    submitTask(task: Task): Promise<TaskResult>;
    cancelAll(reason: Error): void;
}

declare class WasmRunner {
    static run(unit: WorkUnit, signal?: AbortSignal): Promise<WorkUnitResult>;
}

declare class WorkerPool {
    private client;
    private workerCount;
    private isWorkerNode;
    constructor(client: CoordinatorClient);
    reset(): void;
    getWorkerCount(): number;
    getIsWorker(): boolean;
}

declare class PeerTransport {
    private peers;
    private signalingWs?;
    private generation;
    private active;
    private cancelConnecting?;
    private bufferedSends;
    private taskResultCallback?;
    private taskCallback?;
    constructor();
    connect(signalingUrl: string): Promise<void>;
    hasConnection(): boolean;
    disconnect(reason?: Error): void;
    private disconnectSignaling;
    private isCurrentPeer;
    connectToPeer(peerId: string): Promise<void>;
    private handleOffer;
    private handleAnswer;
    private handleIceCandidate;
    private setupDataChannel;
    private safeSend;
    sendTask(peerId: string, wasmBinary: ArrayBuffer, inputData: ArrayBuffer, taskId?: string): Promise<void>;
    sendTaskResult(peerId: string, result: any): void;
    onTaskResult(callback: (result: any, peerId: string) => void): void;
    onTask(callback: (peerId: string, wasmBinary: ArrayBuffer, inputData: ArrayBuffer, taskId: string) => void): void;
    private closeDataChannel;
    private disconnectPeer;
    getConnectedPeers(): string[];
}

export { CoordinatorClient, EventEmitter, PeerTransport, SwarmCompute, type Task, type TaskResult, TaskScheduler, WasmRunner, type WorkUnit, type WorkUnitResult, WorkerPool };
