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
const RESULT = "result";
const STATUS = "status";
const DELAY = "delay";
const EXCEPTION = "exception";
const LOOP = "loop";
const FLOW_PROTOCOL = "flow://";
const INPUT_NAMESPACE = "input.";
const OUTPUT_NAMESPACE = "output.";
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

    public start(): void {
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
                    const uniqueFlows = {};
                    for (const f of flowList) {
                        const filename = String(f);
                        if (filename.endsWith('.yml') || filename.endsWith('.yaml')) {
                            uniqueFlows[filename] = true;
                        } else {
                            log.error(`Ignored ${filename} because it does not have .yml or .yaml file extension`);
                        }
                    }
                    const ordered = Object.keys(uniqueFlows).sort();
                    for (const f of ordered) {
                        try {                            
                            this.createFlow(f, new ConfigReader(prefix + f))
                        } catch (e) {
                            log.error(`Ignore ${f} - ${e.message}`);
                        }
                    }
                }
            } catch (err) {
                log.warn(`Unable to load Event Scripts from ${p} - ${err.message}`);
            }
            const flows = Flows.getAllFlows().sort();
            for (const f of flows) {
                log.info(`Loaded ${f}`);
            }
            log.info(`Event scripts deployed: ${flows.length}`);
        }
    }

    private createFlow(name: string, flow: ConfigReader): void {
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
                log.error(`Skip ${name} - Flow '${id}' already exists`);
                return;
            }
            const unhandledException = exceptionTask && typeof exceptionTask == 'string'? exceptionTask : null;
            // minimum 1 second for TTL
            const ttlSeconds = Math.max(1, util.getDurationInSeconds(timeToLive));
            const extState = ext && typeof ext == 'string'? ext : null;
            const entry: Flow = new Flow(id, firstTask, extState, ttlSeconds * 1000, unhandledException);
            const taskList = flow.get(TASKS);
            const taskCount = Array.isArray(taskList)? taskList.length : 0;
            if (taskCount == 0) {
                log.error(`Unable to parse ${name} - 'tasks' section is empty or invalid`);
                return;
            }
            let endTaskFound = false;
            for (let i=0; i < taskCount; i++) {
                // input or output are optional
                const input = flow.get(TASKS+"["+i+"]."+INPUT, []);
                const output = flow.get(TASKS+"["+i+"]."+OUTPUT, []);
                /*
                 * When "name" is given, it is used for event routing and the "process" can be used
                 * to point to the original composable function.
                 *
                 * When "name" is not provided, the "process" value will be used instead.
                 *
                 * Task description is enforced at compile time for documentation purpose.
                 * It is not used in flow processing.
                 */
                const taskName = flow.getProperty(TASKS+"["+i+"]."+NAME);
                const functionRoute = flow.getProperty(TASKS+"["+i+"]."+PROCESS);
                const taskDesc = flow.get(TASKS+"["+i+"]."+DESCRIPTION);
                const execution = flow.get(TASKS+"["+i+"]."+EXECUTION);
                let delay = flow.getProperty(TASKS+"["+i+"]."+DELAY);
                const taskException = flow.get(TASKS+"["+i+"]."+EXCEPTION);
                const loopStatement = flow.getProperty(TASKS+"["+i+"]."+LOOP+"."+STATEMENT);
                const loopCondition = flow.get(TASKS+"["+i+"]."+LOOP+"."+CONDITION);
                const uniqueTaskName = taskName == null? functionRoute : taskName;
                if (Array.isArray(input) && Array.isArray(output) && 
                    uniqueTaskName && typeof taskDesc == 'string' && 
                    typeof execution == 'string' && this.validExecutionType(execution)) {
                    let validTask = true;
                    if (uniqueTaskName.includes("://") && !uniqueTaskName.startsWith(FLOW_PROTOCOL)) {
                        log.error(`Skip invalid task ${uniqueTaskName} in ${name}. Syntax is flow://{flow-name}`);
                        return;
                    }
                    if (functionRoute && functionRoute.includes("://") && !functionRoute.startsWith(FLOW_PROTOCOL)) {
                        log.error(`Skip invalid task process=${functionRoute} in ${name}. Syntax is flow://{flow-name}`);
                        return;
                    }
                    if (uniqueTaskName.startsWith(FLOW_PROTOCOL) && functionRoute && !functionRoute.startsWith(FLOW_PROTOCOL)) {
                        log.error(`Skip invalid task process=${uniqueTaskName} in ${name}. process tag not allowed when name is a sub-flow`);
                        return;
                    }
                    const task = new Task(uniqueTaskName, functionRoute, execution);
                    if (delay) {
                        if (delay.endsWith("ms")) {
                            // the "ms" suffix is used for documentation purpose only
                            delay = delay.substring(0, delay.length - 2).trim();
                        }
                        if (util.isNumeric(delay)) {
                            const n = Math.max(1, util.str2int(delay));
                            if (n < entry.ttl) {
                                task.setDelay(n);
                            } else {
                                log.error(`Skip invalid task ${uniqueTaskName} in ${name}. delay must be less than TTL`);
                                return;
                            }
                        } else {
                            const dParts = util.split(delay, ".");
                            if (dParts.length > 1 && delay.startsWith(MODEL_NAMESPACE)) {
                                task.setDelayVar(delay);
                            } else {
                                log.error(`Skip invalid task ${uniqueTaskName} in ${name}. delay variable must starts with 'model.'`);
                                return;
                            }
                        }
                    }
                    if (typeof taskException == 'string') {
                        task.setExceptionTask(taskException);
                    }
                    if (END == execution) {
                        endTaskFound = true;
                    } else {
                        if (FORK == execution) {
                            const join = flow.get(TASKS+"["+i+"]."+JOIN);
                            if (typeof join == 'string') {
                                task.setJoinTask(join);
                            } else {
                                log.error(`Skip invalid task ${uniqueTaskName} in ${name}. Missing a join task`);
                                return;
                            }
                        }
                        /*
                         * A sink function does not have next steps.
                         * This task type is used in a "pipeline" or "fork" task.
                         *
                         * A sequential or pipeline must have one next task.
                         */
                        if (SINK != execution) {
                            const nextTasks = flow.get(TASKS+"["+i+"]."+NEXT, []);
                            if (!Array.isArray(nextTasks)) {
                                log.error(`Skip invalid task ${uniqueTaskName} in ${name}. 'next' should be a list`);
                                return;
                            }
                            if (nextTasks.length == 0) {
                                log.error(`Skip invalid task ${uniqueTaskName} in ${name}. Missing a list of next tasks`);
                                return;
                            }
                            if (nextTasks.length > 1 && (SEQUENTIAL == execution || PIPELINE == execution)) {
                                log.error(`Skip invalid task ${uniqueTaskName} in ${name}. Expected one next task, Actual: ${nextTasks.length}`);
                                return;
                            }
                            nextTasks.forEach(t => {
                                task.nextSteps.push(String(t));
                            });
                        }
                        /*
                         * A pipeline task must have at least one pipeline step
                         */
                        if (PIPELINE == execution) {
                            const pipelineList = flow.get(TASKS+"["+i+"]."+PIPELINE, []);
                            if (!Array.isArray(pipelineList)) {
                                log.error(`Skip invalid task ${uniqueTaskName} in ${name}. 'pipeline' should be a list`);
                                return;
                            }
                            if (pipelineList.length == 0) {
                                log.error(`Skip invalid task ${uniqueTaskName} in ${name}. Missing a list of pipeline tasks`);
                                return;
                            }
                            pipelineList.forEach(t => {
                                task.pipelineSteps.push(String(t));
                            });
                            if (loopStatement) {
                                const bracket = loopStatement.indexOf('(');
                                if (bracket == -1) {
                                    log.error(`Skip invalid task ${uniqueTaskName} in ${name}. Please check loop.statement`);
                                    return;
                                }
                                const type = loopStatement.substring(0, bracket).trim();
                                if (type != FOR && type != WHILE) {
                                    log.error(`Skip invalid task ${uniqueTaskName} in ${name}. loop.statement must be 'for' or 'while'`);
                                    return;
                                }
                                task.setLoopType(type);
                                const parts = util.split(loopStatement.substring(bracket+1), "(;)");
                                if (type == FOR) {
                                    if (parts.length < 2 || parts.length > 3) {
                                        log.error(`Skip invalid task ${uniqueTaskName} in ${name}. 'for' loop should have 2 or 3 segments`);
                                        return;
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
                                            log.error(`Skip invalid task ${uniqueTaskName} in ${name}. Please check for-loop initializer.` +
                                                        ' e.g. for (model.n = 0; model.n < 3; model.n++)');
                                            return;
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
                                        log.error(`Skip invalid task ${uniqueTaskName} in ${name}. Please check for-loop syntax.` +
                                                    ' e.g. for (model.n = 0; model.n < 3; model.n++)');
                                        return;
                                    }
                                    if (!this.validForStatement(task.comparator, task.sequencer)) {
                                        log.error(`Skip invalid task ${uniqueTaskName} in ${name}. 'for' loop has invalid comparator or sequencer`);
                                        return;
                                    }
                                } else {
                                    if (parts.length != 1) {
                                        log.error(`Skip invalid task ${uniqueTaskName} in ${name}. 'while' loop should have only one value`);
                                        return;
                                    }
                                    const modelKey = parts[0].trim();
                                    if (!modelKey.startsWith(MODEL_NAMESPACE) || modelKey.includes("=") || modelKey.includes(" ")) {
                                        log.error(`Skip invalid task ${uniqueTaskName} in ${name}. 'while' should use a model key`);
                                        return;
                                    }
                                    task.setWhileModelKey(modelKey);
                                }
                            }
                            if (typeof loopCondition == 'string') {
                                const condition = this.getCondition(loopCondition);
                                if (condition.length == 2) {
                                    task.conditions.push(condition);
                                } else {
                                    log.error(`Skip invalid task ${uniqueTaskName} in ${name}. loop condition syntax error - ${loopCondition}`);
                                    return;
                                }                                
                            }
                            if (Array.isArray(loopCondition)) {
                                for (const c of loopCondition) {
                                    const condition = this.getCondition(String(c));
                                    if (condition.length == 2) {
                                        task.conditions.push(condition);
                                    } else {
                                        const error = JSON.stringify(loopCondition);
                                        log.error(`Skip invalid task ${uniqueTaskName} in ${name}. loop conditions syntax error - ${error}`);
                                        return;
                                    }  
                                }
                            }                                              
                        }                        
                    }
                    for (let j=0; j < input.length; j++) {
                        const line = flow.getProperty(TASKS+"["+i+"]."+INPUT+"["+j+"]");
                        const filtered = this.filterMapping(line);
                        if (this.validInput(filtered)) {
                            const sep = filtered.indexOf(MAP_TO);
                            const rhs = filtered.substring(sep+2).trim();
                            if (rhs.startsWith(INPUT_NAMESPACE) || rhs == INPUT) {
                                log.warn(`Task ${uniqueTaskName} in ${name} uses input namespace in right-hand-side ${line}`);
                            }
                            task.input.push(filtered);
                        } else {
                            log.error(`Skip invalid task ${uniqueTaskName} in ${name} that has invalid input mapping ${line}`);
                            validTask = false;
                        }
                    }
                    const isDecisionTask = DECISION == execution;
                    for (let j=0; j < output.length; j++) {
                        const line = flow.getProperty(TASKS+"["+i+"]."+OUTPUT+"["+j+"]");
                        const filtered = this.filterMapping(line);
                        if (this.validOutput(filtered, isDecisionTask)) {
                            task.output.push(filtered);
                        } else {
                            log.error(`Skip invalid task ${uniqueTaskName} in ${name} that has invalid output mapping ${line}`);
                            validTask = false;
                        }
                    }
                    if (isDecisionTask && task.nextSteps.length < 2) {
                        log.error(`Skip invalid task ${uniqueTaskName} in ${name} must have at least 2 next tasks`);
                        validTask = false;
                    }
                    if (validTask) {
                        entry.addTask(task);
                    }
                } else {
                    log.error(`Unable to parse ${name} - a task must contain input, process, output, description and execution`);
                }
            }
            if (endTaskFound) {
                // final validation pass to check if the flow is missing external.state.machine
                let extFound = false;
                let incomplete = false;
                const taskList = Object.keys(entry.tasks);
                for (const t of taskList) {
                    const task: Task = entry.tasks[t];
                    if (this.hasExternalState(task.input) || this.hasExternalState(task.output)) {
                        extFound = true;
                        break;
                    }
                }
                for (const t of taskList) {
                    const task: Task = entry.tasks[t];
                    if (this.hasIncompleteMapping(task.input) || this.hasIncompleteMapping(task.output)) {
                        incomplete = true;
                        break;
                    }
                }
                if (extFound && entry.externalStateMachine == null) {
                    log.error(`Unable to parse ${name} - flow is missing external.state.machine`);
                } else if (incomplete) {
                    log.error(`Unable to parse ${name} - flow has incomplete data mappings`);
                } else {
                    Flows.addFlow(entry);
                }
            } else {
                log.error(`Unable to parse ${name} - flow must have at least one end task`);
            }
        }
    }

    private hasExternalState(mapping: string[]): boolean {
        for (const m of mapping) {
            const sep = m.indexOf(MAP_TO);
            if (sep != -1) {
                const rhs = m.substring(sep+2).trim();
                if (rhs.startsWith(EXT_NAMESPACE) && EXT_NAMESPACE != rhs) {
                    return true;
                }
            }
        }
        return false;
    }

    private hasIncompleteMapping(mapping: string[]): boolean {
        for (const m of mapping) {
            const sep = m.indexOf(MAP_TO);
            if (sep != -1) {
                const lhs = m.substring(0, sep).trim();
                const rhs = m.substring(sep+2).trim();
                if (lhs.endsWith(".") || rhs.endsWith(".") || rhs.endsWith(":")) {
                    return true;
                }
            } else {
                return true;
            }
        }
        return false;
    }

    private getCondition(statement: string): string[] {
        const parts = util.split(statement, " ()");
        if (parts.length == 3 && parts[0] == "if" && parts[1].startsWith(MODEL_NAMESPACE) && (parts[2] == CONTINUE || parts[2] == BREAK)) {
            const result = [];
            result.push(parts[1]);
            result.push(parts[2]);
            return result;
        } else {
            return [];
        }
    }

    private getForPart1(text: string): string[] {
        // add spaces for easy parsing
        const result = [];
        const parts = util.split(text.replace("=", " = "), " ");
        if (parts.length == 3 && parts[0].startsWith(MODEL_NAMESPACE) && util.isNumeric(parts[2]) && parts[1] == "=") {
            result.push(parts[0]);
            result.push(parts[2]);
        }
        return result;
    }

    private getForPart2(text: string): string[] {
        let s = text;
        // add spaces for easy parsing
        if (s.includes(">=")) {
            s = s.replace(">=", " >= ");
        } else if (s.includes("<=")) {
            s = s.replace("<=", " <= ");
        } else if (s.includes("<")) {
            s = s.replace("<", " < ");
        } else if (s.includes(">")) {
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

    private getForPart3(text: string): string[] {
        const s = text.trim();
        const result = [];
        let plus: boolean;
        if (s.endsWith("++") || s.startsWith("++")) {
            plus = true;
        } else if (s.endsWith("--") || s.startsWith("--")) {
            plus = false;
        } else {
            return result;
        }
        if ((s.startsWith("+") || s.startsWith("-")) && (s.endsWith("+") || s.endsWith("-"))) {
            return result;
        }
        const key = s.replaceAll('+', '').replaceAll('-', '').trim();
        if (key.startsWith(MODEL_NAMESPACE)) {
            result.push(key);
            result.push(plus? INCREMENT : DECREMENT);
        }
        return result;
    }

    private validForStatement(comparator: string[], sequencer: string[]): boolean {
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

    private filterMapping(mapping: string): string {
        const text = mapping.trim();
        const sep = text.indexOf(MAP_TO);
        if (sep == -1) {
            return mapping;
        }
        let lhs = text.substring(0, sep).trim();
        let rhs = text.substring(sep+2).trim();
        // Detect and reformat "negate" of a model value in LHS and RHS
        // !model.key becomes model.key:! for consistent processing by TaskExecutor
        if (lhs.startsWith(NEGATE_MODEL)) {
            lhs = lhs.substring(1) + ":!";
        }
        if (rhs.startsWith(NEGATE_MODEL)) {
            rhs = rhs.substring(1) + ":!";
        }
        return lhs + " " + MAP_TO + " " + rhs;
    }

    private validInput(input: string): boolean {
        const sep = input.indexOf(MAP_TO);
        if (sep > 0) {
            const lhs = input.substring(0, sep).trim();
            const rhs = input.substring(sep+2).trim();
            if (rhs.length > 0) {
                if (lhs == INPUT || lhs.startsWith(INPUT_NAMESPACE) ||
                        lhs.startsWith(MODEL_NAMESPACE) || lhs.startsWith(ERROR_NAMESPACE)) {
                    return true;
                } else if (lhs.startsWith(MAP_TYPE) && lhs.endsWith(CLOSE_BRACKET)) {
                    return this.validKeyValues(lhs);
                } else {
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

    private validKeyValues(text: string): boolean {
        const last = text.lastIndexOf(CLOSE_BRACKET);
        const ref = text.substring(MAP_TYPE.length, last).trim();
        if (ref.includes("=") || ref.includes(",")) {
            const keyValues = util.split(ref, ",");
            const keys = {};
            for (const kv of keyValues) {
                const eq = kv.indexOf('=');
                const k = eq == -1? kv.trim() : kv.substring(0, eq).trim();
                if (k) {
                    keys[k] = true;
                } else {
                    return false;
                }
            }
            return Object.keys(keys).length == keyValues.length;
        } else {
            return ref.length > 0;
        }
    }

    private validOutput(output: string, isDecision: boolean): boolean {
        const sep = output.indexOf(MAP_TO);
        if (sep > 0) {
            const lhs = output.substring(0, sep).trim();
            const rhs = output.substring(sep+2).trim();
            return this.validOutputLhs(lhs) && this.validOutputRhs(rhs, isDecision);
        }
        return false;
    }

    private validOutputLhs(lhs: string): boolean {
        if (lhs == INPUT
                || lhs.startsWith(INPUT_NAMESPACE)
                || lhs.startsWith(MODEL_NAMESPACE)
                || lhs == RESULT || lhs.startsWith(RESULT_NAMESPACE)
                || lhs == STATUS
                || lhs == HEADER || lhs.startsWith(HEADER_NAMESPACE)) {
            return true;
        } else if (lhs.startsWith(MAP_TYPE) && lhs.endsWith(CLOSE_BRACKET)) {
            return this.validKeyValues(lhs);
        } else {
            return (lhs.startsWith(TEXT_TYPE) ||
                    lhs.startsWith(FILE_TYPE) ||
                    lhs.startsWith(INTEGER_TYPE) || lhs.startsWith(LONG_TYPE) ||
                    lhs.startsWith(FLOAT_TYPE) || lhs.startsWith(DOUBLE_TYPE) ||
                    lhs.startsWith(BOOLEAN_TYPE)) && lhs.endsWith(CLOSE_BRACKET);
        }
    }

    private validOutputRhs(rhs: string, isDecision: boolean): boolean {
        return (rhs == DECISION && isDecision) || rhs.startsWith(FILE_TYPE) ||
                rhs.startsWith(OUTPUT_NAMESPACE) || rhs.startsWith(MODEL_NAMESPACE) ||
                rhs.startsWith(EXT_NAMESPACE);
    }

    private validExecutionType(execution: string): boolean {
        for (const s of EXECUTION_TYPES) {
            if (s == execution) {
                return true;
            }
        }
        return false;
    }
}