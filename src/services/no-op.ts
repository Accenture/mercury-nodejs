import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { preload } from '../models/composable.js'

export class NoOp implements Composable {

    @preload('no.op', 10)
    initialize(): NoOp { 
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
       return evt;
    }
}