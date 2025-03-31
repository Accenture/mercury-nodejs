import { EventEnvelope } from '../models/event-envelope.js';
import { Composable, preload } from '../models/composable.js'

export class NoOp implements Composable {

    @preload('no.op', 50)
    initialize(): Composable { 
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
        return evt;
    }
}
