import fs from 'fs';
import { EventEnvelope } from '../models/event-envelope.js';
import { PostOffice, Sender } from '../system/post-office.js';
import { Logger } from '../util/logger.js';
import { Utility, StringBuilder } from '../util/utility.js';
import { MultiLevelMap } from '../util/multi-level-map.js';
import { AppConfig } from '../util/config-reader.js';
import { Flows } from '../models/flows.js';
import { JoinTaskInfo, PipelineInfo } from '../models/pipe.js';
const log = Logger.getInstance();
const util = new Utility();
const EVENT_MANAGER = "event.script.manager";
const TASK_EXECUTOR = "task.executor";
const FIRST_TASK = "first_task";
const FLOW_ID = "flow_id";
const PARENT = "parent";
const FLOW_PROTOCOL = "flow://";
const TYPE = "type";
const PUT = "put";
const KEY = "key";
const REMOVE = "remove";
const ERROR = "error";
const STATUS = "status";
const INPUT = "input";
const OUTPUT_STATUS = "output.status";
const OUTPUT_HEADER = "output.header";
const RESULT = "result";
const HEADER = "header";
const DECISION = "decision";
const INPUT_NAMESPACE = "input.";
const MODEL_NAMESPACE = "model.";
const RESULT_NAMESPACE = "result.";
const ERROR_NAMESPACE = "error.";
const EXT_NAMESPACE = "ext:";
const INPUT_HEADER_NAMESPACE = "input.header.";
const HEADER_NAMESPACE = "header.";
const TEXT_TYPE = "text(";
const INTEGER_TYPE = "int(";
const LONG_TYPE = "long(";
const FLOAT_TYPE = "float(";
const DOUBLE_TYPE = "double(";
const BOOLEAN_TYPE = "boolean(";
const CLASSPATH_TYPE = "classpath(";
const FILE_TYPE = "file(";
const MAP_TYPE = "map(";
const CLOSE_BRACKET = ")";
const TEXT_FILE = "text:";
const JSON_FILE = "json:";
const BINARY_FILE = "binary:";
const APPEND_MODE = "append:";
const MAP_TO = "->";
const ALL = "*";
const END = "end";
const TRUE = "true";
const FALSE = "false";
const NULL = "null";
const RESPONSE = "response";
const SEQUENTIAL = "sequential";
const PARALLEL = "parallel";
const FORK = "fork";
const JOIN = "join";
const PIPELINE = "pipeline";
const SERVICE_AT = "Service ";
const TIMEOUT = "timeout";
const FOR = "for";
const WHILE = "while";
const CONTINUE = "continue";
const BREAK = "break";
const INCREMENT = "++";
const DECREMENT = "--";
const TEXT_SUFFIX = "text";
const BINARY_SUFFIX = "binary";
const B64_SUFFIX = "b64";
const INTEGER_SUFFIX = "int";
const LONG_SUFFIX = "long";
const FLOAT_SUFFIX = "float";
const DOUBLE_SUFFIX = "double";
const BOOLEAN_SUFFIX = "boolean";
const NEGATE_SUFFIX = "!";
const UUID_SUFFIX = "uuid";
const LENGTH_SUFFIX = "length";
const SUBSTRING_TYPE = "substring(";
const CONCAT_TYPE = "concat(";
const AND_TYPE = "and(";
const OR_TYPE = "or(";
const ITEM_SUFFIX = ".ITEM";
const INDEX_SUFFIX = ".INDEX";
const OPERATION = {
    SIMPLE_COMMAND: 1,
    SUBSTRING_COMMAND: 2,
    AND_COMMAND: 3,
    OR_COMMAND: 4,
    BOOLEAN_COMMAND: 5,
    CONCAT_COMMAND: 6
};
class CommandMetadata {
    command;
}
class DynamicIndexMetadata {
    sb = new StringBuilder();
    start = 0;
}
class InputDataMappingMetadata {
    source;
    target;
    flowInstance;
    task;
    dynamicListIndex;
    dynamicListKey;
    headers = {};
}
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class TaskExecutor {
    taskRefs = {};
    maxModelArraySize = 10;
    initialize() {
        const config = AppConfig.getInstance();
        this.maxModelArraySize = util.str2int(config.getProperty("max.model.array.size", "1000"));
        return this;
    }
    async handleEvent(event) {
        const po = new PostOffice(event);
        const self = po.getMyClass();
        const compositeCid = event.getCorrelationId();
        if (compositeCid == null) {
            log.error(`Event ${event.getId()} dropped - missing correlation ID`);
            return false;
        }
        const sep = compositeCid.indexOf('#');
        let cid;
        let seq;
        if (sep > 0) {
            cid = compositeCid.substring(0, sep);
            seq = util.str2int(compositeCid.substring(sep + 1));
        }
        else {
            cid = compositeCid;
            seq = -1;
        }
        /*
         * Resolve unique task reference and release it immediately after use.
         *
         * Two cases when task reference is not found:
         * 1. first task
         * 2. flow timeout
         */
        const ref = self.taskRefs[cid];
        if (ref) {
            delete self.taskRefs[cid];
        }
        const refId = ref == null ? cid : ref.flowInstanceId;
        const flowInstance = Flows.getFlowInstance(refId);
        if (flowInstance == null) {
            log.warn(`Flow instance ${refId} is invalid or expired`);
            return false;
        }
        const flowName = flowInstance.getFlow().id;
        const headers = event.getHeaders();
        if (TIMEOUT in headers) {
            log.warn(`Flow ${flowName}:${flowInstance.id} expired`);
            self.abortFlow(flowInstance, 408, "Flow timeout for " + flowInstance.getFlow().ttl + " ms");
            return false;
        }
        try {
            const firstTask = event.getHeader(FIRST_TASK);
            if (firstTask) {
                await self.executeTask(flowInstance, firstTask);
            }
            else if (await self.checkCallBack(self, event, flowInstance, seq, flowName, refId, ref)) {
                return false;
            }
        }
        catch (e) {
            log.error(`Unable to execute flow ${flowName}:${flowInstance.id} - ${e.message}`);
            self.abortFlow(flowInstance, 500, e.message);
            return false;
        }
        return true;
    }
    async checkCallBack(self, event, flowInstance, seq, flowName, refId, ref) {
        // handle callback from a task
        const from = ref ? ref.processId : event.getFrom();
        if (!from) {
            log.error(`Unable to process callback ${flowName}:${refId} - task does not provide 'from' address`);
            return true;
        }
        const caller = from.includes("@") ? from.substring(0, from.indexOf('@')) : from;
        const task = flowInstance.getFlow().tasks[caller];
        if (task) {
            const statusCode = event.getStatus();
            if (statusCode >= 400 || event.isException()) {
                await self.handleException(self, event, seq, flowInstance, task);
                return true;
            }
        }
        else {
            log.error(`Unable to process callback ${flowName}:${refId} - missing task in ${caller}`);
            return true;
        }
        // clear top level exception state
        flowInstance.setExceptionAtTopLevel(false);
        self.handleCallback(from, flowInstance, task, event, seq);
        return false;
    }
    async handleException(self, event, seq, flowInstance, task) {
        const statusCode = event.getStatus();
        if (seq > 0) {
            if (task.getExceptionTask()) {
                // Clear this specific pipeline queue when task has its own exception handler
                delete flowInstance.pipeMap[seq];
            }
            else {
                /*
                * Clear all pipeline queues when task does not have its own exception handler.
                * System will route the exception to the generic exception handler.
                */
                flowInstance.pipeMap = {};
            }
        }
        const isTaskLevel = task.getExceptionTask() != null;
        const handler = isTaskLevel ? task.getExceptionTask() : flowInstance.getFlow().exception;
        /*
            * Top level exception handler catches all unhandled exceptions.
            *
            * To exception loops at the top level exception handler,
            * abort the flow if top level exception handler throws exception.
            */
        if (handler && !flowInstance.topLevelExceptionHappened()) {
            if (!isTaskLevel) {
                flowInstance.setExceptionAtTopLevel(true);
            }
            const error = { 'code': statusCode, 'message': event.getError() };
            const stackTrace = event.getStackTrace();
            if (stackTrace) {
                error['stack'] = stackTrace;
            }
            await self.executeTask(flowInstance, handler, -1, error);
        }
        else {
            // when there are no task or flow exception handlers
            self.abortFlow(flowInstance, statusCode, event.getError());
        }
    }
    async inputDataMappingModelVar(isInput, lhs, rhs, source, flowInstance) {
        const modelOnly = {};
        modelOnly['model'] = flowInstance.dataset['model'];
        const model = new MultiLevelMap(modelOnly);
        if (isInput || lhs.startsWith(MODEL_NAMESPACE)) {
            const value = this.getLhsElement(lhs, source);
            if (value == null) {
                this.removeModelElement(rhs, model);
            }
            else {
                this.setRhsElement(value, rhs, model);
            }
        }
        else {
            await this.setConstantValue(lhs, rhs, model);
        }
    }
    setInputDataMappingValue(optionalHeaders, entry, rhs, target, value) {
        let valid = true;
        if (ALL == rhs) {
            if (value instanceof Object && !Array.isArray(value)) {
                target.reload(value);
            }
            else {
                valid = false;
            }
        }
        else if (rhs == HEADER) {
            if (value instanceof Object && !Array.isArray(value)) {
                Object.keys(value).forEach(k => {
                    optionalHeaders[k] = String(value[k]);
                });
            }
            else {
                valid = false;
            }
        }
        else if (rhs.startsWith(HEADER_NAMESPACE)) {
            const k = rhs.substring(HEADER_NAMESPACE.length);
            if (k) {
                optionalHeaders[k] = String(value);
            }
        }
        else {
            target.setElement(rhs, value);
        }
        if (!valid) {
            const type = typeof value;
            log.error(`Invalid input mapping '${entry}' - expect: JSON, actual: ${type}`);
        }
    }
    inputDataMappingNormalCase(md, lhs, rhs, entry) {
        let value = this.getLhsElement(lhs, md.source);
        // special cases for simple type matching for a non-exist model variable
        if (value == null && lhs.startsWith(MODEL_NAMESPACE)) {
            value = this.getValueFromNonExistModel(lhs);
        }
        // special case for a dynamic list in fork and join
        if (value == null && md.dynamicListKey) {
            if (lhs == md.dynamicListKey + ITEM_SUFFIX) {
                value = this.getDynamicListItem(md.dynamicListKey, md.dynamicListIndex, md.source);
            }
            if (lhs == md.dynamicListKey + INDEX_SUFFIX) {
                value = md.dynamicListIndex;
            }
        }
        if (value != null) {
            this.setInputDataMappingValue(md.headers, entry, rhs, md.target, value);
        }
    }
    getDynamicListItem(dynamicListKey, dynamicListIndex, source) {
        const value = source.getElement(dynamicListKey);
        if (Array.isArray(value)) {
            return value[dynamicListIndex];
        }
        return value;
    }
    async doInputDataMapping(md, entry, sep) {
        let lhs = this.substituteDynamicIndex(entry.substring(0, sep).trim(), md.source, false);
        const rhs = this.substituteDynamicIndex(entry.substring(sep + 2).trim(), md.source, true);
        const isInput = lhs.startsWith(INPUT_NAMESPACE) || lhs.toLowerCase() == INPUT;
        if (lhs.startsWith(INPUT_HEADER_NAMESPACE)) {
            lhs = lhs.toLowerCase();
        }
        if (rhs.startsWith(EXT_NAMESPACE)) {
            let value = null;
            if (isInput || lhs.startsWith(MODEL_NAMESPACE)) {
                value = this.getLhsElement(lhs, md.source);
            }
            else {
                value = await this.getConstantValue(lhs);
            }
            this.callExternalStateMachine(md.flowInstance, md.task, rhs, value);
        }
        else if (rhs.startsWith(MODEL_NAMESPACE)) {
            // special case to set model variables
            await this.inputDataMappingModelVar(isInput, lhs, rhs, md.source, md.flowInstance);
        }
        else if (isInput || lhs.startsWith(MODEL_NAMESPACE) || lhs.startsWith(ERROR_NAMESPACE)) {
            // normal case to input argument
            this.inputDataMappingNormalCase(md, lhs, rhs, entry);
        }
        else if (rhs.startsWith(HEADER_NAMESPACE)) {
            // Assume left hand side is a constant
            const k = rhs.substring(HEADER_NAMESPACE.length);
            const v = await this.getConstantValue(lhs);
            if (k && v) {
                md.headers[k] = String(v);
            }
        }
        else {
            await this.setConstantValue(lhs, rhs, md.target);
        }
    }
    async runNextFlow(optionalHeaders, compositeCid, target, flowInstance, task) {
        const flowId = task.functionRoute.substring(FLOW_PROTOCOL.length);
        const subFlow = Flows.getFlow(flowId);
        if (!subFlow) {
            log.error(`Unable to process flow ${flowInstance.getFlow().id}:${flowInstance.id} - missing sub-flow ${task.functionRoute}`);
            this.abortFlow(flowInstance, 500, task.functionRoute + " not defined");
            return;
        }
        const dataset = { 'body': target.getMap() };
        if (Object.keys(optionalHeaders).length > 0) {
            dataset['header'] = optionalHeaders;
        }
        const forward = new EventEnvelope().setTo(EVENT_MANAGER).setReplyTo(TASK_EXECUTOR)
            .setHeader(PARENT, flowInstance.id)
            .setHeader(FLOW_ID, flowId).setBody(dataset).setCorrelationId(compositeCid);
        const po = new PostOffice(new Sender(task.functionRoute, flowInstance.getTraceId(), flowInstance.getTracePath()));
        await po.send(forward);
    }
    async runNextTask(optionalHeaders, deferred, compositeCid, target, flowInstance, task) {
        const po = new PostOffice(new Sender(TASK_EXECUTOR, flowInstance.getTraceId(), flowInstance.getTracePath()));
        const event = new EventEnvelope().setTo(task.functionRoute)
            .setCorrelationId(compositeCid)
            .setReplyTo(TASK_EXECUTOR).setBody(target.getMap());
        for (const k of Object.keys(optionalHeaders)) {
            event.setHeader(k, String(optionalHeaders[k]));
        }
        // execute task by sending event
        if (deferred > 0) {
            po.sendLater(event, deferred);
        }
        else {
            await po.send(event);
        }
    }
    resolveDelayVar(source, flowInstance, task) {
        const d = source.getElement(task.getDelayVar());
        if (d) {
            const delay = Math.max(1, util.str2int(String(d)));
            if (delay < flowInstance.getFlow().ttl) {
                return delay;
            }
            else {
                log.warn(`Unable to schedule future task for ${task.service}` +
                    ` because ${task.getDelayVar()} is invalid (TTL=${flowInstance.getFlow().ttl}, delay=${delay})`);
            }
        }
        else {
            log.warn(`Unable to schedule future task for ${task.service} because ${task.getDelayVar()} does not exist`);
        }
        return 0;
    }
    async executeTask(flowInstance, processName, seq = -1, error = {}, dynamicListIndex = -1, dynamicListKey = null) {
        const task = flowInstance.getFlow().tasks[processName];
        const valid = !!task;
        if (!valid) {
            log.error(`Unable to process flow ${flowInstance.getFlow().id}:${flowInstance.id} - missing task '${processName}'`);
            this.abortFlow(flowInstance, 500, SERVICE_AT + processName + " not defined");
            return;
        }
        // add the task to the flow-instance
        flowInstance.tasks.push(task.service == task.functionRoute ? task.service : `${task.service}(${task.functionRoute})`);
        const combined = {};
        combined['input'] = flowInstance.dataset['input'];
        combined['model'] = flowInstance.dataset['model'];
        if (Object.keys(error).length > 0) {
            combined['error'] = error;
        }
        const source = new MultiLevelMap(combined);
        const target = new MultiLevelMap();
        const md = new InputDataMappingMetadata();
        md.flowInstance = flowInstance;
        md.task = task;
        md.source = source;
        md.target = target;
        md.dynamicListIndex = dynamicListIndex;
        md.dynamicListKey = dynamicListKey;
        // perform input data mapping
        const mapping = task.input;
        for (const entry of mapping) {
            const sep = entry.lastIndexOf(MAP_TO);
            if (sep > 0) {
                await this.doInputDataMapping(md, entry, sep);
            }
        }
        // need to send later?
        let deferred = 0;
        if (task.getDelay() > 0) {
            deferred = task.getDelay();
        }
        else if (task.getDelayVar() != null) {
            deferred = this.resolveDelayVar(source, flowInstance, task);
        }
        const uuid = util.getUuid();
        const ref = new TaskReference(flowInstance.id, task.service);
        this.taskRefs[uuid] = ref;
        flowInstance.pendingTasks[uuid] = true;
        const compositeCid = seq > 0 ? uuid + "#" + seq : uuid;
        if (task.functionRoute.startsWith(FLOW_PROTOCOL)) {
            await this.runNextFlow(md.headers, compositeCid, target, flowInstance, task);
        }
        else {
            await this.runNextTask(md.headers, deferred, compositeCid, target, flowInstance, task);
        }
    }
    getValueFromNonExistModel(lhs) {
        const colon = lhs.lastIndexOf(':');
        if (colon > 0) {
            const qualifier = lhs.substring(colon + 1).trim();
            if (UUID_SUFFIX == qualifier) {
                return util.getUuid4();
            }
            else {
                const parts = util.split(qualifier, "(= )");
                if (parts.length == 3 && BOOLEAN_SUFFIX == parts[0] && NULL == parts[1]) {
                    return this.parseBooleanComparator(parts[2]);
                }
            }
        }
        return null;
    }
    parseBooleanComparator(condition) {
        if (TRUE == condition) {
            return true;
        }
        if (FALSE == condition) {
            return false;
        }
        return null;
    }
    async outputDataMappingToFile(value, rhs) {
        const fd = new SimpleFileDescriptor(rhs);
        // automatically create parent folder
        const fileFound = fs.existsSync(fd.fileName);
        if (!fileFound) {
            const parent = this.getParentFolder(fd.fileName);
            if (parent && this.createParentFolders(parent)) {
                log.info(`Folder ${parent} created`);
            }
        }
        if (!fileFound || !util.isDirectory(fd.fileName)) {
            if (value) {
                if (value instanceof Buffer) {
                    await this.saveBytesToFile(fd, value);
                }
                else if (typeof value == 'string') {
                    await this.saveTextToFile(fd, value);
                }
                else if (value instanceof Object) {
                    await this.saveTextToFile(fd, JSON.stringify(value));
                }
                else {
                    await this.saveTextToFile(fd, String(value));
                }
            }
            else if (fileFound)
                fs.rmSync(fd.fileName);
        }
    }
    async saveTextToFile(fd, value) {
        if (fd.mode == 'append') {
            await util.appendStr2file(fd.fileName, value);
        }
        else {
            await util.str2file(fd.fileName, value);
        }
    }
    async saveBytesToFile(fd, value) {
        if (fd.mode == 'append') {
            await util.appendBytes2file(fd.fileName, value);
        }
        else {
            await util.bytes2file(fd.fileName, value);
        }
    }
    outputDateMappingSetValue(entry, consolidated, flowInstance, task, value, rhs) {
        let required = true;
        if (rhs == OUTPUT_STATUS) {
            const status = typeof value == 'number' ? value : util.str2int(String(value));
            if (status < 100 || status > 599) {
                log.error(`Invalid output mapping '${entry}' - expect: valid HTTP status code, actual: ${status}`);
                required = false;
            }
        }
        if (rhs == OUTPUT_HEADER) {
            if (!(value instanceof Object && !Array.isArray(value))) {
                const type = typeof value;
                log.error(`Invalid output mapping '${entry}' - expect: JSON, actual: ${type}`);
                required = false;
            }
        }
        if (rhs.startsWith(EXT_NAMESPACE)) {
            required = false;
            this.callExternalStateMachine(flowInstance, task, rhs, value);
        }
        if (required) {
            this.setRhsElement(value, rhs, consolidated);
        }
    }
    async doOutputDataMapping(entry, sep, consolidated, flowInstance, task) {
        const lhs = this.substituteDynamicIndex(entry.substring(0, sep).trim(), consolidated, false);
        const isInput = lhs.startsWith(INPUT_NAMESPACE) || lhs.toLowerCase() == INPUT;
        let value = null;
        const rhs = this.substituteDynamicIndex(entry.substring(sep + 2).trim(), consolidated, true);
        if (isInput || lhs.startsWith(MODEL_NAMESPACE)
            || lhs == HEADER || lhs.startsWith(HEADER_NAMESPACE)
            || lhs == STATUS
            || lhs == RESULT || lhs.startsWith(RESULT_NAMESPACE)) {
            value = this.getLhsElement(lhs, consolidated);
            if (value == null) {
                this.removeModelElement(rhs, consolidated);
            }
        }
        else {
            value = await this.getConstantValue(lhs);
        }
        if (rhs.startsWith(FILE_TYPE)) {
            await this.outputDataMappingToFile(value, rhs);
        }
        else if (value != null) {
            this.outputDateMappingSetValue(entry, consolidated, flowInstance, task, value, rhs);
        }
        else if (rhs.startsWith(EXT_NAMESPACE)) {
            this.callExternalStateMachine(flowInstance, task, rhs, null);
        }
    }
    handleCallBackFromForkAndJoin(pipe, seq, from, flowInstance) {
        const joinInfo = pipe;
        const callBackCount = ++joinInfo.resultCount;
        log.debug(`Flow ${flowInstance.getFlow().id}:${flowInstance.id} fork-n-join #${seq} result ${callBackCount} of ${joinInfo.forks} from ${from}`);
        if (callBackCount >= joinInfo.forks) {
            delete flowInstance.pipeMap[seq];
            log.debug(`Flow ${flowInstance.getFlow().id}:${flowInstance.id} fork-n-join #${seq} done`);
            this.executeTask(flowInstance, joinInfo.joinTask);
        }
    }
    evaluatePipelineCondition(pipelineTask, consolidated) {
        // check loop-conditions
        let action = null;
        for (const condition of pipelineTask.conditions) {
            /*
            * The first element of a condition is the model key.
            * The second element is "continue" or "break".
            */
            const elements = condition;
            const resolved = this.resolveCondition(elements, consolidated);
            if (resolved) {
                action = resolved;
                if (CONTINUE == resolved) {
                    // clear condition
                    consolidated.setElement(elements[0], false);
                }
                break;
            }
        }
        return action;
    }
    handleCallbackFromPipeline(pipe, seq, consolidated, flowInstance) {
        const pipeline = pipe;
        const pipelineTask = pipeline.getTask();
        if (pipeline.isCompleted()) {
            this.pipelineCompletion(flowInstance, pipeline, consolidated, seq);
            return;
        }
        const n = pipeline.nextStep();
        if (pipeline.isLastStep(n)) {
            pipeline.setCompleted();
            log.debug(`Flow ${flowInstance.getFlow().id}:${flowInstance.id} pipeline #${seq} last step-${n + 1} ${pipeline.getTaskName(n)}`);
        }
        else {
            log.debug(`Flow ${flowInstance.getFlow().id}:${flowInstance.id} pipeline #${seq} next step-${n + 1} ${pipeline.getTaskName(n)}`);
        }
        if (pipelineTask.conditions.length == 0) {
            if (pipeline.isCompleted() && pipeline.isSingleton()) {
                this.pipelineCompletion(flowInstance, pipeline, consolidated, seq);
            }
            else {
                this.executeTask(flowInstance, pipeline.getTaskName(n), seq);
            }
        }
        else {
            const action = this.evaluatePipelineCondition(pipelineTask, consolidated);
            if (BREAK == action) {
                delete flowInstance.pipeMap[seq];
                this.executeTask(flowInstance, pipeline.getExitTask());
            }
            else if (CONTINUE == action) {
                this.pipelineCompletion(flowInstance, pipeline, consolidated, seq);
            }
            else if (pipeline.isCompleted() && pipeline.isSingleton()) {
                this.pipelineCompletion(flowInstance, pipeline, consolidated, seq);
            }
            else {
                this.executeTask(flowInstance, pipeline.getTaskName(n), seq);
            }
        }
    }
    proceedWithNextTask(flowInstance, task, consolidated) {
        const executionType = task.execution;
        // consolidated dataset would be mapped as output for "response", "end" and "decision" tasks
        if (RESPONSE == executionType) {
            this.handleResponseTask(flowInstance, task, consolidated);
        }
        if (END == executionType) {
            this.handleEndTask(flowInstance, task, consolidated);
        }
        if (DECISION == executionType) {
            this.handleDecisionTask(flowInstance, task, consolidated);
        }
        // consolidated dataset should be mapped to model for normal tasks
        if (SEQUENTIAL == executionType) {
            this.queueSequentialTask(flowInstance, task);
        }
        if (PARALLEL == executionType) {
            this.queueParallelTasks(flowInstance, task);
        }
        if (FORK == executionType) {
            this.handleForkAndJoin(flowInstance, task);
        }
        if (PIPELINE == executionType) {
            this.handlePipelineTask(flowInstance, task, consolidated);
        }
    }
    async handleCallback(from, flowInstance, task, event, seq) {
        const combined = {};
        combined['input'] = flowInstance.dataset['input'];
        combined['model'] = flowInstance.dataset['model'];
        combined['status'] = event.getStatus();
        combined['header'] = event.getHeaders();
        combined['result'] = event.getBody();
        const consolidated = new MultiLevelMap(combined);
        // perform output data mapping //
        const mapping = task.output;
        for (const entry of mapping) {
            const sep = entry.lastIndexOf(MAP_TO);
            if (sep > 0) {
                await this.doOutputDataMapping(entry, sep, consolidated, flowInstance, task);
            }
        }
        if (seq > 0 && seq in flowInstance.pipeMap) {
            const pipe = flowInstance.pipeMap[seq];
            // this is a callback from a fork task
            if (JOIN == pipe.getType()) {
                this.handleCallBackFromForkAndJoin(pipe, seq, from, flowInstance);
                return;
            }
            // this is a callback from a pipeline task
            if (PIPELINE == pipe.getType()) {
                this.handleCallbackFromPipeline(pipe, seq, consolidated, flowInstance);
                return;
            }
        }
        this.proceedWithNextTask(flowInstance, task, consolidated);
    }
    resolveCondition(condition, consolidated) {
        if ("true" == String(consolidated.getElement(condition[0]))) {
            return condition[1];
        }
        else {
            return null;
        }
    }
    handleResponseTask(flowInstance, task, map) {
        this.sendResponse(flowInstance, task, map);
        this.queueSequentialTask(flowInstance, task);
    }
    handleEndTask(flowInstance, task, map) {
        this.sendResponse(flowInstance, task, map);
        this.endFlow(flowInstance, true);
    }
    handleDecisionTask(flowInstance, task, map) {
        const decisionValue = map.getElement(DECISION);
        const nextTasks = task.nextSteps;
        let decisionNumber;
        if (typeof decisionValue == 'boolean') {
            decisionNumber = decisionValue ? 1 : 2;
        }
        else if (decisionValue) {
            decisionNumber = Math.max(1, util.str2int(String(decisionValue)));
        }
        else {
            // decision number is not given
            decisionNumber = 0;
        }
        if (decisionNumber < 1 || decisionNumber > nextTasks.length) {
            log.error(`Flow ${flowInstance.getFlow().id}:${flowInstance.id} ${task.service} returned invalid decision (${decisionValue})`);
            this.abortFlow(flowInstance, 500, "Task " + task.service + " returned invalid decision (" + decisionValue + ")");
        }
        else {
            this.executeTask(flowInstance, nextTasks[decisionNumber - 1]);
        }
    }
    handleForkAndJoin(flowInstance, task) {
        const steps = Array.from(task.nextSteps);
        let isList = false;
        const dynamicListKey = task.getSourceModelKey();
        if (dynamicListKey && steps.length == 1) {
            const model = new MultiLevelMap({ 'model': flowInstance.dataset['model'] });
            const items = model.getElement(dynamicListKey);
            if (Array.isArray(items)) {
                isList = true;
                if (items.length > 1) {
                    const singleStep = steps.pop();
                    for (const _ of items) {
                        steps.push(singleStep);
                    }
                }
            }
            else {
                throw new Error(`Flow ${flowInstance.getFlow().id}:${flowInstance.id} ${task.service} - ${dynamicListKey} is not a list`);
            }
        }
        if (steps.length > 0 && task.getJoinTask()) {
            this.executeForkAndJoin(flowInstance, task, steps, isList, dynamicListKey);
        }
    }
    executeForkAndJoin(flowInstance, task, steps, isList, dynamicListKey) {
        const seq = ++flowInstance.pipeCounter;
        const forks = steps.length;
        flowInstance.pipeMap[seq] = new JoinTaskInfo(forks, task.getJoinTask());
        for (let i = 0; i < steps.length; i++) {
            const next = steps[i];
            this.executeTask(flowInstance, next, seq, {}, isList ? i : -1, isList ? dynamicListKey : null);
        }
    }
    runPipeline(task, map) {
        // evaluate initial condition to decide if the pipeline should run
        if (WHILE == task.getLoopType() && task.getWhileModelKey()) {
            const o = map.getElement(task.getWhileModelKey());
            return typeof o == 'boolean' ? o : false;
        }
        else if (FOR == task.getLoopType()) {
            // execute initializer if any
            if (task.init.length == 2) {
                const n = util.str2int(task.init[1]);
                if (task.init[0].startsWith(MODEL_NAMESPACE)) {
                    map.setElement(task.init[0], n);
                }
            }
            return this.evaluateForCondition(map, task.comparator[0], task.comparator[1], task.comparator[2]);
        }
        return true;
    }
    handlePipelineTask(flowInstance, task, map) {
        if (task.pipelineSteps.length > 0) {
            if (this.runPipeline(task, map)) {
                const seq = ++flowInstance.pipeCounter;
                const pipeline = new PipelineInfo(task);
                flowInstance.pipeMap[seq] = pipeline;
                pipeline.resetPointer();
                log.debug(`Flow ${flowInstance.getFlow().id}:${flowInstance.id} pipeline #${seq} begin ${pipeline.getTaskName(0)}`);
                this.executeTask(flowInstance, pipeline.getTaskName(0), seq);
            }
            else {
                this.executeTask(flowInstance, task.nextSteps[0]);
            }
        }
    }
    sendResponse(flowInstance, task, map) {
        const po = new PostOffice(new Sender(TASK_EXECUTOR, flowInstance.getTraceId(), flowInstance.getTracePath()));
        if (flowInstance.isNotResponded()) {
            flowInstance.setResponded(true);
            // is a response event required when the flow is completed?
            if (flowInstance.replyTo) {
                const result = new EventEnvelope();
                // restore the original correlation-ID to the calling party
                result.setTo(flowInstance.replyTo).setCorrelationId(flowInstance.cid);
                const headers = map.getElement("output.header");
                const body = map.getElement("output.body");
                const status = map.getElement("output.status");
                if (status) {
                    const value = util.str2int(String(status));
                    if (value > 0) {
                        result.setStatus(value);
                    }
                    else {
                        log.warn(`Unable to set status in response ${flowInstance.getFlow().id}:${flowInstance.id} - task ${task.service} return status is negative value`);
                    }
                }
                if (headers instanceof Object && !Array.isArray(headers)) {
                    Object.keys(headers).forEach(k => {
                        result.setHeader(k, String(headers[k]));
                    });
                }
                result.setBody(body);
                po.send(result);
            }
        }
    }
    queueSequentialTask(flowInstance, task) {
        const nextTasks = task.nextSteps;
        if (nextTasks.length > 0) {
            this.executeTask(flowInstance, nextTasks[0]);
        }
    }
    queueParallelTasks(flowInstance, task) {
        const nextTasks = task.nextSteps;
        if (nextTasks.length > 0) {
            for (const next of nextTasks) {
                this.executeTask(flowInstance, next);
            }
        }
    }
    pipelineCompletion(flowInstance, pipeline, consolidated, seq) {
        const pipelineTask = pipeline.getTask();
        let iterate = false;
        if (WHILE == pipelineTask.getLoopType() && pipelineTask.getWhileModelKey()) {
            const o = consolidated.getElement(pipelineTask.getWhileModelKey());
            iterate = typeof o == 'boolean' ? o : false;
        }
        else if (FOR == pipelineTask.getLoopType()) {
            // execute sequencer in the for-statement
            const modelValue = consolidated.getElement(pipelineTask.sequencer[0]);
            const v = typeof modelValue == 'number' ? modelValue : util.str2int(modelValue);
            const command = pipelineTask.sequencer[1];
            if (INCREMENT == command) {
                consolidated.setElement(pipelineTask.sequencer[0], v + 1);
            }
            if (DECREMENT == command) {
                consolidated.setElement(pipelineTask.sequencer[0], v - 1);
            }
            // evaluate for-condition
            iterate = this.evaluateForCondition(consolidated, pipelineTask.comparator[0], pipelineTask.comparator[1], pipelineTask.comparator[2]);
        }
        if (iterate) {
            pipeline.resetPointer();
            log.debug(`Flow ${flowInstance.getFlow().id}:${flowInstance.id} pipeline #${seq} first ${pipeline.getTaskName(0)}`);
            this.executeTask(flowInstance, pipeline.getTaskName(0), seq);
        }
        else {
            delete flowInstance.pipeMap[seq];
            this.executeTask(flowInstance, pipeline.getExitTask());
        }
    }
    evaluateForCondition(mm, modelVar1, comparator, modelVar2) {
        const value1 = modelVar1.startsWith(MODEL_NAMESPACE) ? mm.getElement(modelVar1) : modelVar1;
        const value2 = modelVar2.startsWith(MODEL_NAMESPACE) ? mm.getElement(modelVar2) : modelVar2;
        const v1 = typeof value1 == 'number' ? value1 : util.str2int(String(value1));
        const v2 = typeof value2 == 'number' ? value2 : util.str2int(String(value2));
        if (comparator == '<') {
            return v1 < v2;
        }
        if (comparator == '<=') {
            return v1 <= v2;
        }
        if (comparator == '>') {
            return v1 > v2;
        }
        if (comparator == '>=') {
            return v1 >= v2;
        }
        return false;
    }
    getParentFolder(path) {
        const slash = path.lastIndexOf('/');
        return slash == -1 ? null : path.substring(0, slash);
    }
    createParentFolders(path) {
        const parts = path.split('/').filter(v => v.length > 0);
        const sb = new StringBuilder();
        let created = false;
        for (const p of parts) {
            if (p) {
                sb.append(`/${p}`);
                const filePath = sb.getValue();
                if (!fs.existsSync(filePath)) {
                    fs.mkdirSync(filePath);
                    created = true;
                }
            }
        }
        return created;
    }
    callExternalStateMachine(flowInstance, task, rhs, value) {
        const key = rhs.substring(EXT_NAMESPACE.length).trim();
        const externalStateMachine = flowInstance.getFlow().externalStateMachine;
        const po = new PostOffice(new Sender(task.service, flowInstance.getTraceId(), flowInstance.getTracePath()));
        if (externalStateMachine) {
            if (externalStateMachine.startsWith(FLOW_PROTOCOL)) {
                const dataset = new MultiLevelMap();
                dataset.setElement("header.key", key);
                dataset.setElement("header.type", value ? PUT : REMOVE);
                if (value != null) {
                    dataset.setElement("body", { 'data': value });
                }
                const flowId = externalStateMachine.substring(FLOW_PROTOCOL.length);
                const forward = new EventEnvelope().setTo(EVENT_MANAGER)
                    .setHeader(PARENT, flowInstance.id)
                    .setHeader(FLOW_ID, flowId).setBody(dataset.getMap()).setCorrelationId(util.getUuid());
                po.send(forward);
            }
            else if (value) {
                // tell external state machine to save key-value
                po.send(new EventEnvelope()
                    .setTo(externalStateMachine).setBody({ 'data': value }).setHeader(TYPE, PUT).setHeader(KEY, key));
            }
            else {
                // tell external state machine to remove key-value
                po.send(new EventEnvelope()
                    .setTo(externalStateMachine).setHeader(TYPE, REMOVE).setHeader(KEY, key));
            }
        }
    }
    removeModelElement(rhs, model) {
        const colon = this.getModelTypeIndex(rhs);
        if (colon != -1) {
            const key = rhs.substring(0, colon);
            const type = rhs.substring(colon + 1);
            const value = this.getValueByType(type, null, "?", model);
            if (value != null) {
                this.setRhsElement(value, key, model);
            }
            else {
                delete model[key];
            }
        }
        else {
            model.removeElement(rhs);
        }
    }
    setRhsElement(value, rhs, target) {
        let updated = false;
        const colon = this.getModelTypeIndex(rhs);
        const selector = colon == -1 ? rhs : rhs.substring(0, colon).trim();
        if (colon != -1) {
            const type = rhs.substring(colon + 1).trim();
            const matched = this.getValueByType(type, value, "RHS '" + rhs + "'", target);
            target.setElement(selector, matched);
            updated = true;
        }
        if (!updated) {
            target.setElement(selector, value);
        }
    }
    async setConstantValue(lhs, rhs, target) {
        const value = await this.getConstantValue(lhs);
        if (value != null) {
            this.setRhsElement(value, rhs, target);
        }
        else {
            this.removeModelElement(rhs, target);
        }
    }
    getConstantAsMap(lhs, last) {
        const ref = lhs.substring(MAP_TYPE.length, last).trim();
        if (ref.includes("=") || ref.includes(",")) {
            const keyValues = util.split(ref, ",");
            const map = {};
            for (const kv of keyValues) {
                const eq = kv.indexOf('=');
                const k = eq == -1 ? kv.trim() : kv.substring(0, eq).trim();
                const v = eq == -1 ? "" : kv.substring(eq + 1).trim();
                if (k) {
                    map[k] = v;
                }
            }
            return map;
        }
        else {
            return AppConfig.getInstance().get(ref);
        }
    }
    getConstantByType(lhs, last) {
        if (lhs.startsWith(TEXT_TYPE)) {
            return lhs.substring(TEXT_TYPE.length, last);
        }
        if (lhs.startsWith(INTEGER_TYPE)) {
            return util.str2int(lhs.substring(INTEGER_TYPE.length, last).trim());
        }
        if (lhs.startsWith(LONG_TYPE)) {
            return util.str2int(lhs.substring(LONG_TYPE.length, last).trim());
        }
        if (lhs.startsWith(FLOAT_TYPE)) {
            return util.str2float(lhs.substring(FLOAT_TYPE.length, last).trim());
        }
        if (lhs.startsWith(DOUBLE_TYPE)) {
            return util.str2float(lhs.substring(DOUBLE_TYPE.length, last).trim());
        }
        if (lhs.startsWith(BOOLEAN_TYPE)) {
            return TRUE == lhs.substring(BOOLEAN_TYPE.length, last).trim().toLowerCase();
        }
        if (lhs.startsWith(MAP_TYPE)) {
            return this.getConstantAsMap(lhs, last);
        }
        return null;
    }
    async getConstantFromFile(lhs) {
        if (lhs.startsWith(FILE_TYPE) || lhs.startsWith(CLASSPATH_TYPE)) {
            const fd = new SimpleFileDescriptor(lhs);
            if (fs.existsSync(fd.fileName) && !util.isDirectory(fd.fileName)) {
                if (fd.mode == 'text') {
                    return await util.file2str(fd.fileName);
                }
                else if (fd.mode == 'json') {
                    return await this.getJson(await util.file2str(fd.fileName));
                }
                else if (fd.mode == 'binary') {
                    return await util.file2bytes(fd.fileName);
                }
            }
        }
        return null;
    }
    async getJson(text) {
        const content = text.trim();
        if (content.startsWith('[') && content.endsWith(']') || content.startsWith('{') && content.endsWith('}')) {
            return JSON.parse(content);
        }
        else {
            return content;
        }
    }
    async getConstantValue(lhs) {
        const f = await this.getConstantFromFile(lhs);
        if (f) {
            return f;
        }
        const last = lhs.lastIndexOf(CLOSE_BRACKET);
        if (last > 0) {
            const v = this.getConstantByType(lhs, last);
            if (v) {
                return v;
            }
        }
        return null;
    }
    getLhsElement(lhs, source) {
        const colon = this.getModelTypeIndex(lhs);
        const selector = colon == -1 ? lhs : lhs.substring(0, colon).trim();
        const value = source.getElement(selector);
        if (colon != -1) {
            const type = lhs.substring(colon + 1).trim();
            return this.getValueByType(type, value, "LHS '" + lhs + "'", source);
        }
        return value;
    }
    validateIndexBounds(ptr, text) {
        if (ptr > this.maxModelArraySize) {
            throw new Error("Cannot set RHS to index > " + ptr
                + " that exceeds max " + this.maxModelArraySize + " - " + text);
        }
        if (ptr < 0) {
            throw new Error(`Cannot set RHS to negative index - ${text}`);
        }
    }
    checkDynamicIndex(md, open, close, text, source, isRhs) {
        md.sb.append(text.substring(md.start, open + 1));
        const idx = text.substring(open + 1, close).trim();
        if (idx.startsWith(MODEL_NAMESPACE)) {
            const ptr = util.str2int(String(source.getElement(idx)));
            if (isRhs) {
                this.validateIndexBounds(ptr, text);
            }
            md.sb.append(String(ptr));
        }
        else {
            if (isRhs && idx) {
                const ptr = util.str2int(idx);
                if (ptr < 0) {
                    throw new Error(`Cannot set RHS to negative index - ${text}`);
                }
            }
            md.sb.append(idx);
        }
        md.sb.append(']');
        md.start = close + 1;
    }
    substituteDynamicIndex(statement, source, isRhs) {
        const text = this.substituteRuntimeVarsIfAny(statement, source);
        if (text.includes('[') && text.includes(']')) {
            const md = new DynamicIndexMetadata();
            while (md.start < text.length) {
                const open = text.indexOf('[', md.start);
                const close = text.indexOf(']', md.start);
                if (open != -1 && close > open) {
                    this.checkDynamicIndex(md, open, close, text, source, isRhs);
                }
                else {
                    md.sb.append(text.substring(md.start));
                    break;
                }
            }
            return md.sb.getValue();
        }
        else {
            return text;
        }
    }
    getStringFromModelValue(obj) {
        return typeof obj == 'string' || typeof obj == 'number' ? String(obj) : "null";
    }
    replaceWithRuntimeVar(s, sb, start, text, source) {
        const heading = text.substring(start, s.start);
        if (heading) {
            sb.append(heading);
        }
        const middle = text.substring(s.start + 1, s.end - 1).trim();
        if (middle.startsWith(MODEL_NAMESPACE) && !middle.endsWith(".")) {
            sb.append(this.getStringFromModelValue(source.getElement(middle)));
        }
        else {
            sb.append(text.substring(s.start, s.end));
        }
        return s.end;
    }
    substituteRuntimeVarsIfAny(text, source) {
        if (text.includes("{") && text.includes("}")) {
            const segments = util.extractSegments(text, "{", "}");
            if (segments.length == 0) {
                return text;
            }
            else {
                let start = 0;
                const sb = new StringBuilder();
                for (const s of segments) {
                    start = this.replaceWithRuntimeVar(s, sb, start, text, source);
                }
                const lastSegment = text.substring(start);
                if (lastSegment) {
                    sb.append(lastSegment);
                }
                return sb.getValue();
            }
        }
        else {
            return text;
        }
    }
    getTextValue(value) {
        if (typeof value == 'string') {
            return value;
        }
        // Buffer must be tested before Object
        if (value instanceof Buffer) {
            return String(value);
        }
        if (value instanceof Object) {
            return JSON.stringify(value);
        }
        // set as string is unknown type
        return String(value);
    }
    getBinaryValue(value) {
        if (value instanceof Buffer) {
            return value;
        }
        if (typeof value == 'string') {
            return Buffer.from(value);
        }
        if (value instanceof Object) {
            return Buffer.from(JSON.stringify(value));
        }
        return Buffer.from(String(value));
    }
    getLenValue(value) {
        if (value) {
            if (Array.isArray(value) || value instanceof Buffer || typeof value == 'string') {
                return value.length;
            }
            else {
                return String(value).length;
            }
        }
        else {
            return 0;
        }
    }
    convertB64(value) {
        if (value instanceof Buffer) {
            return util.bytesToBase64(value);
        }
        if (typeof value == 'string') {
            return util.base64ToBytes(value);
        }
        return util.base64ToBytes(String(value));
    }
    getValueWithSuffix(type, value) {
        if (TEXT_SUFFIX == type) {
            return this.getTextValue(value);
        }
        if (BINARY_SUFFIX == type) {
            return this.getBinaryValue(value);
        }
        if (BOOLEAN_SUFFIX == type) {
            return "true" == String(value).toLowerCase();
        }
        if (NEGATE_SUFFIX == type) {
            return "true" != String(value).toLowerCase();
        }
        if (INTEGER_SUFFIX == type || LONG_SUFFIX == type) {
            return util.str2int(String(value));
        }
        if (FLOAT_SUFFIX == type || DOUBLE_SUFFIX == type) {
            return util.str2float(String(value));
        }
        if (UUID_SUFFIX == type) {
            return util.getUuid4();
        }
        if (LENGTH_SUFFIX == type) {
            return this.getLenValue(value);
        }
        if (B64_SUFFIX == type) {
            return this.convertB64(value);
        }
        throw new Error(`matching type must be substring(start, end), boolean, and, or, text, binary or b64`);
    }
    getSubstring(command, value) {
        const parts = util.split(command, ", ");
        if (parts.length > 0 && parts.length < 3) {
            if (typeof value == 'string') {
                const start = util.str2int(parts[0]);
                const end = parts.length == 1 ? value.length : util.str2int(parts[1]);
                if (end > start && start >= 0 && end <= value.length) {
                    return value.substring(start, end);
                }
                else {
                    throw new Error("index out of bound");
                }
            }
            else {
                throw new Error("value is not a string");
            }
        }
        else {
            throw new Error("invalid syntax");
        }
    }
    getConcatValue(command, value, data) {
        const parts = this.tokenizeConcatParameters(command);
        if (parts.length == 0) {
            throw new Error("parameters must be model variables and/or text constants");
        }
        else {
            const sb = new StringBuilder();
            sb.append(String(value));
            for (const p of parts) {
                if (p.startsWith(TEXT_TYPE)) {
                    sb.append(p.substring(TEXT_TYPE.length, p.length - 1));
                }
                if (p.startsWith(MODEL_NAMESPACE)) {
                    const v = String(data.getElement(p));
                    sb.append(v);
                }
            }
            return sb.getValue();
        }
    }
    getBooleanLogicalValue(selection, command, value, data) {
        if (command.startsWith(MODEL_NAMESPACE)) {
            const v1 = "true" == String(value);
            const v2 = "true" == String(data.getElement(command));
            return selection == OPERATION.AND_COMMAND ? v1 && v2 : v1 || v2;
        }
        else {
            throw new Error(`'${command}' is not a model variable`);
        }
    }
    getBooleanValue(command, value) {
        const parts = util.split(command, ",=");
        const filtered = [];
        parts.forEach(d => {
            const txt = d.trim();
            if (txt) {
                filtered.push(txt);
            }
        });
        if (filtered.length > 0 && filtered.length < 3) {
            // enforce value to a text string where null value will become "null"
            const str = String(value);
            const condition = filtered.length == 1 || "true" == filtered[1].toLowerCase();
            if (str == filtered[0]) {
                return condition;
            }
            else {
                return !condition;
            }
        }
        else {
            throw new Error("invalid syntax");
        }
    }
    tokenizeConcatParameters(text) {
        const result = new Array();
        const md = new CommandMetadata();
        md.command = text.trim();
        while (md.command) {
            let outcome = 'empty';
            if (md.command.startsWith(MODEL_NAMESPACE)) {
                outcome = this.tokenizeModelParameter(md, result);
            }
            else if (md.command.startsWith(TEXT_TYPE)) {
                outcome = this.tokenizeTextParameter(md, result);
            }
            if (outcome == 'empty') {
                return [];
            }
            else if (outcome == 'break') {
                break;
            }
        }
        return result;
    }
    tokenizeModelParameter(md, result) {
        const sep = md.command.indexOf(',');
        if (sep == -1) {
            result.push(md.command);
            return "break";
        }
        else {
            const token = md.command.substring(0, sep).trim();
            if (token == MODEL_NAMESPACE) {
                return "empty";
            }
            else {
                result.push(token);
                md.command = md.command.substring(sep + 1).trim();
                return "continue";
            }
        }
    }
    tokenizeTextParameter(md, result) {
        const close = md.command.indexOf(CLOSE_BRACKET);
        if (close == 1) {
            return "empty";
        }
        else {
            result.push(md.command.substring(0, close + 1));
            const sep = md.command.indexOf(',', close);
            if (sep == -1) {
                return "break";
            }
            else {
                md.command = md.command.substring(sep + 1).trim();
                return "continue";
            }
        }
    }
    getModelTypeIndex(text) {
        if (text.startsWith(MODEL_NAMESPACE)) {
            return text.indexOf(':');
        }
        else {
            return -1;
        }
    }
    getMappingType(type) {
        if (type.startsWith(SUBSTRING_TYPE)) {
            return OPERATION.SUBSTRING_COMMAND;
        }
        else if (type.startsWith(AND_TYPE)) {
            return OPERATION.AND_COMMAND;
        }
        else if (type.startsWith(OR_TYPE)) {
            return OPERATION.OR_COMMAND;
        }
        else if (type.startsWith(BOOLEAN_TYPE)) {
            return OPERATION.BOOLEAN_COMMAND;
        }
        else if (type.startsWith(CONCAT_TYPE)) {
            return OPERATION.CONCAT_COMMAND;
        }
        else {
            return OPERATION.SIMPLE_COMMAND;
        }
    }
    getValueByType(type, value, path, data) {
        try {
            const selection = this.getMappingType(type);
            if (selection == OPERATION.SIMPLE_COMMAND) {
                return this.getValueWithSuffix(type, value);
            }
            else if (type.endsWith(CLOSE_BRACKET)) {
                const command = type.substring(type.indexOf('(') + 1, type.length - 1).trim();
                /*
                * substring(start, end)]
                * substring(start)
                * boolean(value=true)
                * boolean(value) is same as boolean(value=true)
                * and(model.anotherKey)
                * or(model.anotherKey)
                */
                if (selection == OPERATION.SUBSTRING_COMMAND) {
                    return this.getSubstring(command, value);
                }
                else if (selection == OPERATION.CONCAT_COMMAND) {
                    return this.getConcatValue(command, value, data);
                }
                else if (selection == OPERATION.AND_COMMAND || selection == OPERATION.OR_COMMAND) {
                    return this.getBooleanLogicalValue(selection, command, value, data);
                }
                else if (selection == OPERATION.BOOLEAN_COMMAND) {
                    return this.getBooleanValue(command, value);
                }
            }
            else {
                throw new Error('missing close bracket');
            }
        }
        catch (e) {
            if (e instanceof Error) {
                log.error(`Unable to do ${type} of ${path} - ${e.message}`);
            }
        }
        return value;
    }
    abortFlow(flowInstance, status, message) {
        if (flowInstance.isNotResponded()) {
            flowInstance.setResponded(true);
            const result = {};
            result['status'] = status;
            result['message'] = message;
            result['type'] = ERROR;
            const error = new EventEnvelope();
            // restore the original correlation-ID to the calling party
            error.setTo(flowInstance.replyTo).setCorrelationId(flowInstance.cid);
            error.setStatus(status).setBody(result);
            const po = new PostOffice(new Sender(TASK_EXECUTOR, flowInstance.getTraceId(), flowInstance.getTracePath()));
            po.send(error);
        }
        this.endFlow(flowInstance, false);
    }
    endFlow(flowInstance, normal) {
        flowInstance.close();
        Flows.closeFlowInstance(flowInstance.id);
        // clean up task references and release memory
        Object.keys(flowInstance.pendingTasks).forEach(k => {
            delete this.taskRefs[k];
        });
        const traceId = flowInstance.getTraceId();
        const now = new Date().getTime();
        const diff = Math.max(0, now - flowInstance.getStartMillis());
        const formatted = util.getElapsedTime(diff);
        const totalExecutions = flowInstance.tasks.length;
        const s = totalExecutions == 1 ? "" : "s";
        const logId = traceId || flowInstance.id;
        const po = new PostOffice();
        const payload = {};
        const metrics = {};
        const annotations = {};
        payload["trace"] = metrics;
        payload["annotations"] = annotations;
        metrics["origin"] = po.getId();
        metrics["id"] = logId;
        metrics["service"] = "task.executor";
        metrics["from"] = "event.script.manager";
        metrics["exec_time"] = diff;
        metrics["start"] = new Date(flowInstance.getStartMillis()).toISOString();
        metrics["path"] = flowInstance.getTracePath();
        metrics["status"] = normal ? 200 : 400;
        metrics["success"] = normal;
        if (!normal) {
            metrics["exception"] = "Flow aborted";
        }
        annotations["execution"] = `Run ${totalExecutions} task${s} in ${formatted}`;
        annotations["tasks"] = flowInstance.tasks;
        annotations["flow"] = flowInstance.getFlow().id;
        po.send(new EventEnvelope().setTo("distributed.tracing").setBody(payload));
    }
}
class TaskReference {
    flowInstanceId;
    processId;
    constructor(flowInstanceId, processId) {
        this.flowInstanceId = flowInstanceId;
        this.processId = processId;
    }
}
class SimpleFileDescriptor {
    fileName;
    mode;
    constructor(value) {
        let isResource = false;
        const last = value.lastIndexOf(CLOSE_BRACKET);
        let offset = 0;
        if (value.startsWith(FILE_TYPE)) {
            offset = FILE_TYPE.length;
        }
        else if (value.startsWith(CLASSPATH_TYPE)) {
            offset = CLASSPATH_TYPE.length;
            isResource = true;
        }
        let name;
        const filePath = value.substring(offset, last).trim();
        if (filePath.startsWith(TEXT_FILE)) {
            name = filePath.substring(TEXT_FILE.length);
            this.mode = 'text';
        }
        else if (filePath.startsWith(JSON_FILE)) {
            name = filePath.substring(JSON_FILE.length);
            this.mode = 'json';
        }
        else if (filePath.startsWith(BINARY_FILE)) {
            name = filePath.substring(BINARY_FILE.length);
            this.mode = 'binary';
        }
        else if (filePath.startsWith(APPEND_MODE)) {
            name = filePath.substring(APPEND_MODE.length);
            this.mode = 'append';
        }
        else {
            // default fileType is binary
            name = filePath;
            this.mode = 'binary';
        }
        name = util.normalizeFilePath(name.startsWith('/') ? name : '/' + name);
        this.fileName = isResource ? this.resolveClassPath(name) : name;
    }
    resolveClassPath(resourceFile) {
        const resourcePath = AppConfig.getInstance().get('resource.path');
        return resourcePath + resourceFile;
    }
}
//# sourceMappingURL=task-executor.js.map