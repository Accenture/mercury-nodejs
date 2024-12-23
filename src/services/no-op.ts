import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { preload } from '../models/composable.js'

export class NoOp implements Composable {
    
    name = "no.op";

    @preload(10)
    initialize(): void {
        // no-op
    }

    getName(): string {
        return this.name;
    }

    async handleEvent(evt: EventEnvelope) {
       return evt;
    }
}