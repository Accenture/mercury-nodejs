export declare class LocalPubSub {
    constructor();
    createTopic(topic: string): void;
    deleteTopic(topic: string): void;
    getTopics(): Array<string>;
    topicExists(topic: string): boolean;
    getSubscribers(topic: string): Array<string>;
    subscribe(topic: string, memberRoute: string): boolean;
    unsubscribe(topic: string, memberRoute: string): void;
}
