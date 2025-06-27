import { Logger } from '../util/logger.js';
import { Utility } from '../util/utility.js';
import { AppConfig, ConfigReader } from '../util/config-reader.js';
import { Flows } from '../models/flows.js';
import { Flow } from '../models/flow.js';
import { Task } from '../models/task.js';
const log = Logger.getInstance();
const util = new Utility();
const INPUT = "input";
const PROCESS = "process";
const NAME = "name";
const OUTPUT = "output";
const DESCRIPTION = "description";
const EXECUTION = "execution";
const SOURCE = "source";
const RESULT = "result";
const STATUS = "status";
const DELAY = "delay";
const EXCEPTION = "exception";
const LOOP = "loop";
const FLOW_PROTOCOL = "flow://";
const INPUT_NAMESPACE = "input.";
const OUTPUT_NAMESPACE = "output.";
const MODEL = "model";
const PARENT = "parent";
const MODEL_NAMESPACE = "model.";
const NEGATE_MODEL = "!model.";
const RESULT_NAMESPACE = "result.";
const HEADER_NAMESPACE = "header.";
const HEADER = "header";
const ERROR_NAMESPACE = "error.";
const EXT_NAMESPACE = "ext:";
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
const MAP_TO = "->";
const SPACED_MAP_TO = " -> ";
const TASKS = "tasks";
const NEXT = "next";
const JOIN = "join";
const STATEMENT = "statement";
const FOR = "for";
const WHILE = "while";
const CONTINUE = "continue";
const BREAK = "break";
const INCREMENT = "++";
const DECREMENT = "--";
const CONDITION = "condition";
const DECISION = "decision";
const RESPONSE = "response";
const END = "end";
const SEQUENTIAL = "sequential";
const PARALLEL = "parallel";
const PIPELINE = "pipeline";
const FORK = "fork";
const SINK = "sink";
const EXECUTION_TYPES = [DECISION, RESPONSE, END, SEQUENTIAL, PARALLEL, PIPELINE, FORK, SINK];
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class CompileFlows {
    start() {
        const config = AppConfig.getInstance();
        const locations = config.getProperty("yaml.flow.automation", "classpath:/flows.yaml");
        const paths = util.split(locations, ', ');
        for (const p of paths) {
            try {
                const reader = new ConfigReader(p);
                log.info(`Loading event scripts from ${p}`);
                const prefix = reader.getProperty("location", "classpath:/flows/");
                const flowList = reader.get("flows");
                if (Array.isArray(flowList)) {
                    this.loadFlows(flowList, prefix);
                }
            }
            catch (err) {
                log.warn(`Unable to load Event Scripts from ${p} - ${err.message}`);
            }
            const flows = Flows.getAllFlows().sort((a, b) => a.localeCompare(b));
            for (const f of flows) {
                log.info(`Loaded ${f}`);
            }
            log.info(`Event scripts deployed: ${flows.length}`);
        }
    }
    loadFlows(flowList, prefix) {
        const uniqueFlows = {};
        for (const f of flowList) {
            const filename = String(f);
            if (filename.endsWith('.yml') || filename.endsWith('.yaml')) {
                uniqueFlows[filename] = true;
            }
            else {
                log.error(`Ignored ${filename} because it does not have .yml or .yaml file extension`);
            }
        }
        const ordered = Object.keys(uniqueFlows).sort((a, b) => a.localeCompare(b));
        for (const f of ordered) {
            try {
                this.createFlow(f, new ConfigReader(prefix + f));
            }
            catch (e) {
                log.error(`Ignore ${f} - ${e.message}`);
            }
        }
    }
    createFlow(name, flow) {
        log.info(`Parsing ${name}`);
        const id = flow.get("flow.id");
        const description = flow.get("flow.description");
        const timeToLive = flow.get("flow.ttl");
        const exceptionTask = flow.get("flow.exception");
        const firstTask = flow.get("first.task");
        const ext = flow.get("external.state.machine");
        /*
         * Flow description is enforced at compile time for documentation purpose.
         * It is not used in flow processing.
         */
        if (typeof id == 'string' && typeof description == 'string' &&
            typeof timeToLive == 'string' && typeof firstTask == 'string') {
            if (Flows.flowExists(id)) {
                throw new Error(`Skip ${name} - Flow '${id}' already exists`);
            }
            const topLevelException = exceptionTask && typeof exceptionTask == 'string' ? exceptionTask : null;
            // minimum 1 second for TTL
            const ttlSeconds = Math.max(1, util.getDurationInSeconds(timeToLive));
            const extState = ext && typeof ext == 'string' ? ext : null;
            const entry = new Flow(id, firstTask, extState, ttlSeconds * 1000, topLevelException);
            const taskList = flow.get(TASKS);
            const taskCount = Array.isArray(taskList) ? taskList.length : 0;
            if (taskCount == 0) {
                throw new Error(`Unable to parse ${name} - 'tasks' section is empty or invalid`);
            }
            this.parseTaskList(taskCount, entry, flow, name);
        }
        else {
            log.error(`Unable to parse ${name} - check flow.id, flow.description, flow.ttl, first.task`);
        }
    }
    parseTaskList(taskCount, entry, flow, name) {
        let endTaskCount = 0;
        for (let i = 0; i < taskCount; i++) {
            if (this.parseTask(entry, flow, i, name)) {
                endTaskCount++;
            }
        }
        if (endTaskCount > 0) {
            this.addFlow(entry, name);
        }
        else {
            throw new Error(`Unable to parse ${name} - flow must have at least one end task`);
        }
    }
    parseTask(entry, flow, i, name) {
        // input or output are optional
        const input = flow.get(TASKS + "[" + i + "]." + INPUT, []);
        const output = flow.get(TASKS + "[" + i + "]." + OUTPUT, []);
        /*
        * When "name" is given, it is used for event routing and the "process" can be used
        * to point to the original composable function.
        *
        * When "name" is not provided, the "process" value will be used instead.
        *
        * Task description is enforced at compile time for documentation purpose.
        * It is not used in flow processing.
        */
        const taskName = flow.getProperty(TASKS + "[" + i + "]." + NAME);
        const functionRoute = flow.getProperty(TASKS + "[" + i + "]." + PROCESS);
        const taskDesc = flow.get(TASKS + "[" + i + "]." + DESCRIPTION);
        const execution = flow.get(TASKS + "[" + i + "]." + EXECUTION);
        const delay = flow.getProperty(TASKS + "[" + i + "]." + DELAY);
        const taskException = flow.get(TASKS + "[" + i + "]." + EXCEPTION);
        const uniqueTaskName = taskName ?? functionRoute;
        if (this.isValidTaskConfiguration(input, output, uniqueTaskName, taskDesc, execution, name, i)) {
            this.validateTaskName(uniqueTaskName, functionRoute, name);
            const task = new Task(uniqueTaskName, functionRoute, execution);
            if (delay) {
                this.setDelay(entry, task, delay, uniqueTaskName, name);
            }
            if (typeof taskException == 'string') {
                task.setExceptionTask(taskException);
            }
            this.addTask(entry, flow, task, i, uniqueTaskName, name);
        }
        return END == execution;
    }
    isValidTaskConfiguration(input, output, uniqueTaskName, taskDesc, execution, flowName, taskIndex) {
        if (!Array.isArray(input)) {
            log.error(`Unable to parse ${flowName} task ${taskIndex} - input must be a list`);
            return false;
        }
        if (!Array.isArray(output)) {
            log.error(`Unable to parse ${flowName} task ${taskIndex} - output must be a list`);
            return false;
        }
        if (!uniqueTaskName) {
            log.error(`Unable to parse ${flowName} task ${taskIndex} - task name must not be empty`);
            return false;
        }
        if (typeof taskDesc != 'string' || taskDesc.length == 0) {
            log.error(`Unable to parse ${flowName} task ${taskIndex} - description must not be empty`);
            return false;
        }
        if (typeof execution != 'string' || execution.length == 0) {
            log.error(`Unable to parse ${flowName} task ${taskIndex} - execution type must not be empty`);
            return false;
        }
        if (!this.validExecutionType(execution)) {
            log.error(`Unable to parse ${flowName} task ${taskIndex} - execution type '${execution}' must be one of ${JSON.stringify(EXECUTION_TYPES)}`);
            return false;
        }
        return true;
    }
    validateTaskName(uniqueTaskName, functionRoute, name) {
        if (uniqueTaskName.includes("://") && !uniqueTaskName.startsWith(FLOW_PROTOCOL)) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. Syntax is flow://{flow-name}`);
        }
        if (functionRoute && functionRoute.includes("://") && !functionRoute.startsWith(FLOW_PROTOCOL)) {
            throw new Error(`Skip invalid task process=${functionRoute} in ${name}. Syntax is flow://{flow-name}`);
        }
        if (uniqueTaskName.startsWith(FLOW_PROTOCOL) && functionRoute && !functionRoute.startsWith(FLOW_PROTOCOL)) {
            throw new Error(`Skip invalid task process=${uniqueTaskName} in ${name}. process tag not allowed when name is a sub-flow`);
        }
    }
    addTask(entry, flow, task, i, uniqueTaskName, name) {
        const execution = flow.get(TASKS + "[" + i + "]." + EXECUTION);
        if (FORK == execution) {
            this.parseJoinTask(flow, task, i, uniqueTaskName, name);
        }
        if (SINK != execution && END != execution) {
            this.parseNonSinkTask(flow, task, i, uniqueTaskName, name);
        }
        if (PIPELINE == execution) {
            this.parsePipeline(flow, task, i, uniqueTaskName, name);
        }
        if (this.parseInputDataMapping(flow, task, i, uniqueTaskName, name) && this.parseOutputDataMapping(flow, task, i, uniqueTaskName, name)) {
            entry.addTask(task);
        }
    }
    parseInputDataMapping(flow, task, i, uniqueTaskName, name) {
        const input = flow.get(TASKS + "[" + i + "]." + INPUT, []);
        const inputList = [];
        for (let j = 0; j < input.length; j++) {
            inputList.push(flow.getProperty(TASKS + "[" + i + "]." + INPUT + "[" + j + "]"));
        }
        let valid = true;
        const filteredInputMapping = this.filterDataMapping(inputList);
        for (const line of filteredInputMapping) {
            if (this.validInput(line)) {
                const sep = line.lastIndexOf(MAP_TO);
                const rhs = line.substring(sep + 2).trim();
                if (rhs.startsWith(INPUT_NAMESPACE) || rhs == INPUT) {
                    log.warn(`Task ${uniqueTaskName} in ${name} uses input namespace in right-hand-side - ${line}`);
                }
                task.input.push(line);
            }
            else {
                log.error(`Skip invalid task ${uniqueTaskName} in ${name} that has invalid input mapping - ${line}`);
                valid = false;
            }
        }
        return valid;
    }
    parseOutputDataMapping(flow, task, i, uniqueTaskName, name) {
        const output = flow.get(TASKS + "[" + i + "]." + OUTPUT, []);
        const execution = flow.get(TASKS + "[" + i + "]." + EXECUTION);
        const isDecision = DECISION == execution;
        const outputList = [];
        for (let j = 0; j < output.length; j++) {
            outputList.push(flow.getProperty(TASKS + "[" + i + "]." + OUTPUT + "[" + j + "]"));
        }
        let valid = true;
        const filteredOutputMapping = this.filterDataMapping(outputList);
        for (const line of filteredOutputMapping) {
            if (this.validOutput(line, isDecision)) {
                task.output.push(line);
            }
            else {
                log.error(`Skip invalid task ${uniqueTaskName} in ${name} that has invalid output mapping - ${line}`);
                valid = false;
            }
        }
        if (isDecision && task.nextSteps.length < 2) {
            log.error(`Skip invalid task ${uniqueTaskName} in ${name} must have at least 2 next tasks`);
            valid = false;
        }
        return valid;
    }
    parseJoinTask(flow, task, i, uniqueTaskName, name) {
        const join = flow.get(TASKS + "[" + i + "]." + JOIN);
        if (typeof join == 'string') {
            task.setJoinTask(join);
        }
        else {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. Missing a join task`);
        }
    }
    parseNonSinkTask(flow, task, i, uniqueTaskName, name) {
        const source = flow.getProperty(TASKS + "[" + i + "]." + SOURCE);
        const execution = flow.get(TASKS + "[" + i + "]." + EXECUTION);
        const nextTasks = flow.get(TASKS + "[" + i + "]." + NEXT, []);
        if (!Array.isArray(nextTasks)) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. 'next' should be a list`);
        }
        if (nextTasks.length == 0) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. Missing a list of next tasks`);
        }
        if (nextTasks.length > 1 && (SEQUENTIAL == execution || PIPELINE == execution)) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. Expected one next task, Actual: ${nextTasks.length}`);
        }
        if (nextTasks.length > 1 && source) {
            throw new Error(`Invalid ${execution} task ${uniqueTaskName} in ${name}.`
                + ` Expected one next task if dynamic model source is used, Actual: ${nextTasks.length}`);
        }
        if (source) {
            if (source.startsWith(MODEL_NAMESPACE) && !source.endsWith(".")) {
                task.setSourceModelKey(source);
            }
            else {
                throw new Error(`Invalid ${execution} task ${uniqueTaskName} in ${name}.`
                    + ` Source must start with model namespace, Actual: ${source}`);
            }
        }
        nextTasks.forEach(t => {
            task.nextSteps.push(String(t));
        });
    }
    parsePipeline(flow, task, i, uniqueTaskName, name) {
        const loopStatement = flow.getProperty(TASKS + "[" + i + "]." + LOOP + "." + STATEMENT);
        const loopCondition = flow.get(TASKS + "[" + i + "]." + LOOP + "." + CONDITION);
        const pipelineList = flow.get(TASKS + "[" + i + "]." + PIPELINE, []);
        if (!Array.isArray(pipelineList)) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. 'pipeline' should be a list`);
        }
        if (pipelineList.length == 0) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. Missing a list of pipeline tasks`);
        }
        pipelineList.forEach(t => {
            task.pipelineSteps.push(String(t));
        });
        if (loopStatement) {
            this.parseLoopStatement(loopStatement, task, uniqueTaskName, name);
        }
        if (typeof loopCondition == 'string') {
            const condition = this.getCondition(loopCondition);
            if (condition.length == 2) {
                task.conditions.push(condition);
            }
            else {
                throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. loop condition syntax error - ${loopCondition}`);
            }
        }
        if (Array.isArray(loopCondition)) {
            for (const c of loopCondition) {
                const condition = this.getCondition(String(c));
                if (condition.length == 2) {
                    task.conditions.push(condition);
                }
                else {
                    const error = JSON.stringify(loopCondition);
                    throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. loop conditions syntax error - ${error}`);
                }
            }
        }
    }
    parseLoopStatement(loopStatement, task, uniqueTaskName, name) {
        const bracket = loopStatement.indexOf('(');
        if (bracket == -1) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. Please check loop.statement`);
        }
        const type = loopStatement.substring(0, bracket).trim();
        if (type != FOR && type != WHILE) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. loop.statement must be 'for' or 'while'`);
        }
        task.setLoopType(type);
        const parts = util.split(loopStatement.substring(bracket + 1), "(;)");
        if (type == FOR) {
            this.parseForLoop(task, parts, uniqueTaskName, name);
        }
        else {
            this.parseWhileLoop(task, parts, uniqueTaskName, name);
        }
    }
    parseForLoop(task, parts, uniqueTaskName, name) {
        if (parts.length < 2 || parts.length > 3) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. 'for' loop should have 2 or 3 segments`);
        }
        if (parts.length == 2) {
            const comparator = this.getForPart2(parts[0]);
            const sequencer = this.getForPart3(parts[1]);
            comparator.forEach(v => {
                task.comparator.push(v);
            });
            sequencer.forEach(v => {
                task.sequencer.push(v);
            });
        }
        if (parts.length == 3) {
            const initializer = this.getForPart1(parts[0]);
            if (initializer.length == 0) {
                throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. Please check for-loop initializer.` +
                    ' e.g. for (model.n = 0; model.n < 3; model.n++)');
            }
            initializer.forEach(v => {
                task.init.push(v);
            });
            const comparator = this.getForPart2(parts[1]);
            const sequencer = this.getForPart3(parts[2]);
            comparator.forEach(v => {
                task.comparator.push(v);
            });
            sequencer.forEach(v => {
                task.sequencer.push(v);
            });
        }
        if (task.comparator.length == 0 || task.sequencer.length == 0) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. Please check for-loop syntax.` +
                ' e.g. for (model.n = 0; model.n < 3; model.n++)');
        }
        if (!this.validForStatement(task.comparator, task.sequencer)) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. 'for' loop has invalid comparator or sequencer`);
        }
    }
    parseWhileLoop(task, parts, uniqueTaskName, name) {
        if (parts.length != 1) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. 'while' loop should have only one value`);
        }
        const modelKey = parts[0].trim();
        if (!modelKey.startsWith(MODEL_NAMESPACE) || modelKey.includes("=") || modelKey.includes(" ")) {
            throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. 'while' should use a model key`);
        }
        task.setWhileModelKey(modelKey);
    }
    setDelay(entry, task, delay, uniqueTaskName, name) {
        if (delay.endsWith("ms")) {
            // the "ms" suffix is used for documentation purpose only
            delay = delay.substring(0, delay.length - 2).trim();
        }
        if (util.isNumeric(delay)) {
            const n = Math.max(1, util.str2int(delay));
            if (n < entry.ttl) {
                task.setDelay(n);
            }
            else {
                throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. delay must be less than TTL`);
            }
        }
        else {
            const dParts = util.split(delay, ".");
            if (dParts.length > 1 && delay.startsWith(MODEL_NAMESPACE)) {
                task.setDelayVar(delay);
            }
            else {
                throw new Error(`Skip invalid task ${uniqueTaskName} in ${name}. delay variable must starts with 'model.'`);
            }
        }
    }
    addFlow(entry, name) {
        // final validation pass to check if the flow is missing external.state.machine
        let extFound = false;
        let incomplete = false;
        const taskList = Object.keys(entry.tasks);
        for (const t of taskList) {
            const task = entry.tasks[t];
            if (this.hasExternalState(task.input) || this.hasExternalState(task.output)) {
                extFound = true;
                break;
            }
        }
        for (const t of taskList) {
            const task = entry.tasks[t];
            if (this.hasIncompleteMapping(task.input) || this.hasIncompleteMapping(task.output)) {
                incomplete = true;
                break;
            }
        }
        if (extFound && entry.externalStateMachine == null) {
            log.error(`Unable to parse ${name} - flow is missing external.state.machine`);
        }
        else if (incomplete) {
            log.error(`Unable to parse ${name} - flow has invalid data mappings`);
        }
        else {
            Flows.addFlow(entry);
        }
    }
    hasExternalState(mapping) {
        for (const m of mapping) {
            const sep = m.indexOf(MAP_TO);
            if (sep != -1) {
                const rhs = m.substring(sep + 2).trim();
                if (rhs.startsWith(EXT_NAMESPACE) && EXT_NAMESPACE != rhs) {
                    return true;
                }
            }
        }
        return false;
    }
    hasIncompleteMapping(mapping) {
        for (const m of mapping) {
            const sep = m.indexOf(MAP_TO);
            if (sep != -1) {
                const lhs = m.substring(0, sep).trim();
                const rhs = m.substring(sep + 2).trim();
                if (lhs.endsWith(".") || rhs.endsWith(".") || rhs.endsWith(":")) {
                    return true;
                }
            }
            else {
                return true;
            }
        }
        return false;
    }
    getCondition(statement) {
        const parts = util.split(statement, " ()");
        if (parts.length == 3 && parts[0] == "if" && parts[1].startsWith(MODEL_NAMESPACE) && (parts[2] == CONTINUE || parts[2] == BREAK)) {
            const result = [];
            result.push(parts[1]);
            result.push(parts[2]);
            return result;
        }
        else {
            return [];
        }
    }
    getForPart1(text) {
        // add spaces for easy parsing
        const result = [];
        const parts = util.split(text.replace("=", " = "), " ");
        if (parts.length == 3 && parts[0].startsWith(MODEL_NAMESPACE) && util.isNumeric(parts[2]) && parts[1] == "=") {
            result.push(parts[0]);
            result.push(parts[2]);
        }
        return result;
    }
    getForPart2(text) {
        let s = text;
        // add spaces for easy parsing
        if (s.includes(">=")) {
            s = s.replace(">=", " >= ");
        }
        else if (s.includes("<=")) {
            s = s.replace("<=", " <= ");
        }
        else if (s.includes("<")) {
            s = s.replace("<", " < ");
        }
        else if (s.includes(">")) {
            s = s.replace(">", " > ");
        }
        const result = [];
        const parts = util.split(s, " ");
        if (parts.length == 3 &&
            (parts[0].startsWith(MODEL_NAMESPACE) || util.isNumeric(parts[0])) &&
            (parts[2].startsWith(MODEL_NAMESPACE) || util.isNumeric(parts[2])) &&
            (parts[1] == ">=" || parts[1] == "<=" || parts[1] == ">" || parts[1] == "<")) {
            result.push(parts[0]);
            result.push(parts[1]);
            result.push(parts[2]);
        }
        return result;
    }
    getForPart3(text) {
        const s = text.trim();
        const result = [];
        let plus;
        if (s.endsWith("++") || s.startsWith("++")) {
            plus = true;
        }
        else if (s.endsWith("--") || s.startsWith("--")) {
            plus = false;
        }
        else {
            return result;
        }
        if ((s.startsWith("+") || s.startsWith("-")) && (s.endsWith("+") || s.endsWith("-"))) {
            return result;
        }
        const key = s.replaceAll('+', '').replaceAll('-', '').trim();
        if (key.startsWith(MODEL_NAMESPACE)) {
            result.push(key);
            result.push(plus ? INCREMENT : DECREMENT);
        }
        return result;
    }
    validForStatement(comparator, sequencer) {
        const keys = [];
        for (const k of comparator) {
            if (k.startsWith(MODEL_NAMESPACE)) {
                keys.push(k);
            }
        }
        if (keys.length == 0) {
            return false;
        }
        if (keys.length == 2 && keys[0] == keys[1]) {
            return false;
        }
        let found = false;
        for (const k of keys) {
            if (k == sequencer[0]) {
                found = true;
            }
        }
        return found;
    }
    filterDataMapping(entries) {
        const result = new Array();
        for (const line of entries) {
            let entry = line.trim();
            if (entry.startsWith(TEXT_TYPE)) {
                result.push(this.filterMapping(entry));
            }
            else {
                const parts = new Array();
                while (entry.includes(MAP_TO)) {
                    const sep = entry.indexOf(MAP_TO);
                    const first = entry.substring(0, sep).trim();
                    parts.push(first);
                    entry = entry.substring(sep + 2).trim();
                }
                parts.push(entry);
                if (parts.length == 2) {
                    result.push(this.filterMapping(parts[0] + SPACED_MAP_TO + parts[1]));
                }
                else if (parts.length == 3) {
                    this.handleThreePartFormat(result, parts);
                }
                else {
                    result.push("Syntax must be (LHS -> RHS) or (LHS -> model.variable -> RHS)");
                }
            }
        }
        return result;
    }
    handleThreePartFormat(result, parts) {
        /*
        * 3-part mapping format handling:
        * 1. The middle part must be a model variable
        * 2. It will decompose into two entries of 2-part mappings
        * 3. Any type information of the LHS of the second entry will be dropped
        *
        * For example,
        *
        * BEFORE
        * - 'boolean(true) -> !model.bool -> negate_value'
        * AFTER
        * - 'boolean(true) -> model.bool:!'
        * - 'model.bool -> negate_value'
        */
        if (parts[1].startsWith(MODEL_NAMESPACE) || parts[1].startsWith(NEGATE_MODEL)) {
            result.push(this.filterMapping(parts[0] + SPACED_MAP_TO + parts[1]));
            const secondLhs = this.trimTypeQualifier(parts[1]);
            result.push(this.filterMapping(secondLhs + SPACED_MAP_TO + parts[2]));
        }
        else {
            result.push("3-part data mapping must have model variable as the middle part");
        }
    }
    filterMapping(mapping) {
        const text = mapping.trim();
        const sep = text.lastIndexOf(MAP_TO);
        if (sep == -1) {
            return mapping;
        }
        let lhs = text.substring(0, sep).trim();
        let rhs = text.substring(sep + 2).trim();
        if (lhs.startsWith(NEGATE_MODEL)) {
            lhs = this.normalizedNegateTypeMapping(lhs);
        }
        if (rhs.startsWith(NEGATE_MODEL)) {
            rhs = this.normalizedNegateTypeMapping(rhs);
        }
        return lhs + SPACED_MAP_TO + rhs;
    }
    normalizedNegateTypeMapping(negate) {
        /*
         * Convert convenient negate (!) to internal format (:!)
         * e.g. !model.something becomes model.something:!
         */
        return (negate.includes(":") ? negate.substring(1, negate.indexOf(':')) : negate.substring(1)) + ":!";
    }
    trimTypeQualifier(lhs) {
        const step1 = lhs.startsWith("!") ? lhs.substring(1) : lhs;
        return step1.includes(":") ? step1.substring(0, step1.indexOf(':')) : step1;
    }
    validInput(input) {
        const sep = input.lastIndexOf(MAP_TO);
        if (sep > 0) {
            const lhs = input.substring(0, sep).trim();
            const rhs = input.substring(sep + 2).trim();
            if (this.validModel(lhs) && this.validModel(rhs) && lhs != rhs) {
                if (lhs == INPUT || lhs.startsWith(INPUT_NAMESPACE) ||
                    lhs.startsWith(MODEL_NAMESPACE) || lhs.startsWith(ERROR_NAMESPACE)) {
                    return true;
                }
                else if (lhs.startsWith(MAP_TYPE) && lhs.endsWith(CLOSE_BRACKET)) {
                    return this.validKeyValues(lhs);
                }
                else {
                    return (lhs.startsWith(TEXT_TYPE) ||
                        lhs.startsWith(FILE_TYPE) || lhs.startsWith(CLASSPATH_TYPE) ||
                        lhs.startsWith(INTEGER_TYPE) || lhs.startsWith(LONG_TYPE) ||
                        lhs.startsWith(FLOAT_TYPE) || lhs.startsWith(DOUBLE_TYPE) ||
                        lhs.startsWith(BOOLEAN_TYPE)) && lhs.endsWith(CLOSE_BRACKET);
                }
            }
        }
        return false;
    }
    validModel(key) {
        const parts = util.split(key, "!: ()");
        if (parts.length == 0) {
            return false;
        }
        else {
            // "model" alone to access the whole model dataset is not allowed
            if (MODEL == parts[0]) {
                return false;
            }
            // model.parent to access the whole parent namespace is not allowed
            if (parts[0].startsWith(MODEL_NAMESPACE)) {
                const segments = util.split(parts[0], ".");
                return segments.length != 1 && (segments.length != 2 || PARENT != segments[1]);
            }
            return true;
        }
    }
    validKeyValues(text) {
        const last = text.lastIndexOf(CLOSE_BRACKET);
        const ref = text.substring(MAP_TYPE.length, last).trim();
        if (ref.includes("=") || ref.includes(",")) {
            const keyValues = util.split(ref, ",");
            const keys = {};
            for (const kv of keyValues) {
                const eq = kv.indexOf('=');
                const k = eq == -1 ? kv.trim() : kv.substring(0, eq).trim();
                if (k) {
                    keys[k] = true;
                }
                else {
                    return false;
                }
            }
            return Object.keys(keys).length == keyValues.length;
        }
        else {
            return ref.length > 0;
        }
    }
    validOutput(output, isDecision) {
        const sep = output.lastIndexOf(MAP_TO);
        if (sep > 0) {
            const lhs = output.substring(0, sep).trim();
            const rhs = output.substring(sep + 2).trim();
            if (this.validModel(lhs) && this.validModel(rhs) && lhs != rhs) {
                return this.validOutputLhs(lhs) && this.validOutputRhs(rhs, isDecision);
            }
        }
        return false;
    }
    validOutputLhs(lhs) {
        if (lhs == INPUT
            || lhs.startsWith(INPUT_NAMESPACE)
            || lhs.startsWith(MODEL_NAMESPACE)
            || lhs == RESULT || lhs.startsWith(RESULT_NAMESPACE)
            || lhs == STATUS
            || lhs == HEADER || lhs.startsWith(HEADER_NAMESPACE)) {
            return true;
        }
        else if (lhs.startsWith(MAP_TYPE) && lhs.endsWith(CLOSE_BRACKET)) {
            return this.validKeyValues(lhs);
        }
        else {
            return (lhs.startsWith(TEXT_TYPE) ||
                lhs.startsWith(FILE_TYPE) || lhs.startsWith(CLASSPATH_TYPE) ||
                lhs.startsWith(INTEGER_TYPE) || lhs.startsWith(LONG_TYPE) ||
                lhs.startsWith(FLOAT_TYPE) || lhs.startsWith(DOUBLE_TYPE) ||
                lhs.startsWith(BOOLEAN_TYPE)) && lhs.endsWith(CLOSE_BRACKET);
        }
    }
    validOutputRhs(rhs, isDecision) {
        return (rhs == DECISION && isDecision) || rhs.startsWith(FILE_TYPE) ||
            rhs.startsWith(OUTPUT_NAMESPACE) || rhs.startsWith(MODEL_NAMESPACE) ||
            rhs.startsWith(EXT_NAMESPACE);
    }
    validExecutionType(execution) {
        for (const s of EXECUTION_TYPES) {
            if (s == execution) {
                return true;
            }
        }
        return false;
    }
}
//# sourceMappingURL=compile-flows.js.map