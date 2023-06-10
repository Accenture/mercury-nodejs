export declare class PubSub {
    constructor();
    createTopic(topic: string): void;
    deleteTopic(topic: string): void;
    getTopics(): Array<string>;
    getSubscribers(topic: string): Array<string>;
    subscribe(topic: string, memberRoute: string): boolean;
    unsubscribe(topic: string, memberRoute: string): void;
}
