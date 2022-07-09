export declare class AppException extends Error {
    private status;
    constructor(status: number, message: string);
    /**
     * Note that status code should be compliant with the 3-digit numeric HTTP status code convention.
     * i.e. HTTP-2xx for success, HTTP-4xx for application related issues and HTTP-5xx for infrastructure failures.
     *
     * @returns status code
     */
    getStatus(): number;
    /**
     * Retrieve the exception message
     *
     * @returns message
     */
    getMessage(): string;
    /**
     * Encode composite error message for easy validation in unit tests
     *
     * @returns composite error message
     */
    toString(): string;
}
