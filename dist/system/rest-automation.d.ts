import { RequestHandler } from 'express';
export declare class RestAutomation {
    /**
     * Enable REST automation
     */
    constructor();
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
    /**
     * Optional: Setup additional Express middleware
     *
     * IMPORTANT: This API is provided for backward compatibility with existing code
     * that uses Express plugins. In a composable application, you can achieve the same
     * functionality by declaring your user function as an "interceptor" in "preload.yaml".
     *
     * User defined middleware has input arguments (req: Request, res: Response, next: NextFunction).
     * It must call the "next()" method at the end of processing to pass the request and response
     * objects to the rest-automation engine for further processing.
     *
     * It should not touch the request body for multipart file upload because the rest-automation
     * engine will take care of it.
     *
     * If you must add middleware, call this method before you execute the "start" method in
     * rest-automation. Please refer to the BeforeAll section in po.test.ts file as a worked
     * example.
     *
     * @param handler implements RequestHandler
     */
    setupMiddleWare(handler: RequestHandler): void;
}
