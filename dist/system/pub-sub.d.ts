/// <reference types="node" />
export declare class PubSub {
    constructor(domain?: string);
    getInstance(): PS;
}
declare class PS {
    private domain;
    private subscription;
    constructor(domain: string);
    /**
     * Check if pub/sub feature is supported
     *
     * @returns true or false
     */
    featureEnabled(): Promise<string | number | boolean | object | Uint8Array | Buffer>;
    /**
     * Retrieve the list of topics
     *
     * @returns list of topics
     */
    listTopics(): Promise<string | number | boolean | object | Uint8Array | Buffer>;
    /**
     * Check if a topic exists
     *
     * @param topic in the network event stream system
     * @returns true or false
     */
    exists(topic: string): Promise<string | number | boolean | object | Uint8Array | Buffer>;
    /**
     * Create a topic with a given number of partitions
     * (Note that only journaled network event stream system like Kafka and Event Hubs support
     *  partitioning)
     *
     * @param topic in the network event stream system
     * @param partition Optional number of partitions to be created. Default -1 to disable the partitioning feature
     * @returns true or false
     */
    createTopic(topic: string, partition?: number): Promise<string | number | boolean | object | Uint8Array | Buffer>;
    /**
     * Retrieve the number of partitions for a topic
     *
     * @param topic in the network event stream system
     * @returns number of partitions if any. Otherwise -1
     */
    partitionCount(topic: string): Promise<string | number | boolean | object | Uint8Array | Buffer>;
    /**
     * Delete a topic
     * (IMPORTANT: do not delete a topic if the topic has subscribers. The underlying network event stream
     *  system may crash if you do that. Topic administration is usually done by DevSecOps.)
     *
     * @param topic in the network event stream system
     * @returns true or false
     */
    deleteTopic(topic: string): Promise<string | number | boolean | object | Uint8Array | Buffer>;
    /**
     * Publish an event
     * (If it is a journaled network event stream system, this will publish the event randomly to any
     *  available partition)
     *
     * @param topic in the network event stream system
     * @param headers of the event, optional
     * @param body of the event
     * @returns true or false
     */
    publish(topic: string, headers: object, body: any): Promise<string | number | boolean | object | Uint8Array | Buffer>;
    /**
     * Publish an event to a specific partition
     *
     * @param topic in the network event stream system
     * @param partition number of the topic
     * @param headers of the event, optional
     * @param body of the event
     * @returns true or false
     */
    publishToPartition(topic: string, partition: number, headers: object, body: any): Promise<string | number | boolean | object | Uint8Array | Buffer>;
    /**
     * Subscribe to a topic with a listener service route
     *
     * @param topic in the network event stream system
     * @param route of your service that listens to the incoming events
     * @param parameters required if the target network event stream system is journaled
     * @returns true or false
     */
    subscribe(topic: string, route: string, parameters: Array<string>): Promise<boolean>;
    /**
     * Subscribe to a topic and a specific partition with a listener service route
     *
     * @param topic in the network event stream system
     * @param partition number of the topic
     * @param route of your service that listens to the incoming events
     * @param parameters required if the target network event stream system is journaled
     * @returns true or false
     */
    subscribeToPartition(topic: string, partition: number, route: string, parameters: Array<string>): Promise<boolean>;
    /**
     * Unsubscribe your service route from a topic
     *
     * @param topic required if the target network event stream system is journale
     * @param route of your service that listens to the incoming events
     * @returns true or false
     */
    unsubscribe(topic: string, route: string): Promise<string | number | boolean | object>;
}
export {};
