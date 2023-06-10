export declare class RestAutomation {
    /**
     * Enable REST automation
     *
     * @param configFile location of application.yml or a JSON object configuration base configuration
     *
     *
     */
    constructor(configFile?: string | object);
    /**
     * Start the REST automation engine
     *
     * If "rest.automation.yaml" is defined in application.yml, REST automation will render the
     * rest.yaml file to accept the configured REST endpoints.
     * Otherwise, it will skip REST automation and provide basic actuator endpoints such as /info and /health
     */
    start(): void;
    /**
     * Stop the REST automation engine
     *
     * @returns true when the stop command is executed.
     */
    stop(): Promise<boolean>;
}
