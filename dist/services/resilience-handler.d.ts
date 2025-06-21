import { EventEnvelope } from '../models/event-envelope.js';
import { Composable } from '../models/composable.js';
export declare class ResilienceHandler implements Composable {
    initialize(): Composable;
    handleEvent(event: EventEnvelope): Promise<boolean>;
    private makeDecision;
    private triggerBackoff;
    private handleBackoff;
    private sendResult;
}
