import { EventEnvelope } from "./event-envelope.js";
export interface Composable {
    name: string;
    initialize(): void;
    getName(): string;
    handleEvent(evt: EventEnvelope): Promise<string | boolean | number | object | EventEnvelope | null>;
}
export declare function preload(): (_target: any, propertyKey: string, descriptor: PropertyDescriptor) => void;
