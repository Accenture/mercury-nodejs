import './ws-service.js';
export declare class Connector {
    constructor();
    getInstance(): CloudConnector;
}
declare class CloudConnector {
    private target;
    private apiKey;
    constructor();
    /**
     * Tell the system to connect to the cloud via a language connector
     *
     * @param reconnect is true or false
     */
    connectToCloud(reconnect?: boolean): void;
}
export {};
