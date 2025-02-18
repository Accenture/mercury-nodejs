import { EventEnvelope } from '../models/event-envelope.js';
import { PostOffice } from '../system/post-office.js';
import { Platform } from '../system/platform.js';
import { Composable } from '../models/composable.js';
import { Logger } from '../util/logger.js';
import { Flows } from '../models/flows.js';
import { Flow } from '../models/flow.js';
import { FlowInstance } from '../models/flow_instance.js';
import { CompileFlows } from './compile-flows.js';
import { TaskExecutor } from './task-executor.js';
import { HttpToFlow } from '../adapters/http-to-flow.js';

const log = Logger.getInstance();
const EVENT_MANAGER = "event.script.manager";
const TASK_EXECUTOR = "task.executor";
const HTTP_FLOW_ADAPTER = "http.flow.adapter";
const FIRST_TASK = "first_task";
const FLOW_ID = "flow_id";

let started = false;

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class EventScriptEngine {

    async start() {
        if (!started) {
            started = true;
            const platform = Platform.getInstance();
            await platform.getReady();
            // compile flows
            const compileFlow = new CompileFlows();
            compileFlow.start();
            // register system functions for event flow processing
            platform.register(EVENT_MANAGER, new EventScriptManager(), 1, true, true);
            platform.register(TASK_EXECUTOR, new TaskExecutor(), 1, true, true);
            platform.register(HTTP_FLOW_ADAPTER, new HttpToFlow(), 200, true, true);
        }
    }
}

export class EventScriptManager implements Composable {

    initialize(): Composable {
        return this;
    }
    
    async handleEvent(event: EventEnvelope) {
        const po = new PostOffice(event.getHeaders());
        const self = po.getMyClass() as EventScriptManager;
        try {
            const flowId = event.getHeader(FLOW_ID);
            if (!flowId) {
                throw new Error("Missing "+FLOW_ID);
            }
            await self.processRequest(event, flowId);
        } catch (e) {
            const message = e.message? e.message : 'unknown error';
            log.error(`Unable to process request - ${message}`);
            if (event.getReplyTo() && event.getCorrelationId()) {
                const error = new EventEnvelope()
                        .setTo(event.getReplyTo()).setCorrelationId(event.getCorrelationId())
                        .setStatus(500).setBody(message);
                await po.send(error);
            }
        }
        return null;
    }

    private async processRequest(event: EventEnvelope, flowId: string) {
        const po = new PostOffice(event.getHeaders());
        const flowInstance = this.getFlowInstance(event, flowId, Flows.getFlow(flowId));
        Flows.addFlowInstance(flowInstance);
        // Set the input event body into the flow dataset
        flowInstance.dataset['input'] = event.getBody();
        // Execute the first task and use the unique flow instance as correlation ID during flow execution
        const firstTask = new EventEnvelope().setFrom(EVENT_MANAGER)
                .setTo(TASK_EXECUTOR).setCorrelationId(flowInstance.id)
                .setHeader(FIRST_TASK, flowInstance.getFlow().firstTask);
        await po.send(firstTask);
    }

    private getFlowInstance(event: EventEnvelope, flowId: string, template: Flow): FlowInstance {
        if (template == null) {
            throw new Error("Flow "+ flowId +" not found");
        }
        const cid = event.getCorrelationId();
        if (!cid) {
            throw new Error("Missing correlation ID for "+ flowId);
        }
        const replyTo = event.getReplyTo();
        // Save the original correlation-ID ("cid") from the calling party in a flow instance and
        // return this value to the calling party at the end of flow execution
        const flowInstance = new FlowInstance(flowId, cid, replyTo, template);
        // Optional distributed trace
        const traceId = event.getTraceId();
        const tracePath = event.getTracePath();
        if (traceId != null && tracePath != null) {
            flowInstance.setTrace(traceId, tracePath);
        }
        return flowInstance;
    }
}
