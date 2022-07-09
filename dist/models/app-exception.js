export class AppException extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
    /**
     * Note that status code should be compliant with the 3-digit numeric HTTP status code convention.
     * i.e. HTTP-2xx for success, HTTP-4xx for application related issues and HTTP-5xx for infrastructure failures.
     *
     * @returns status code
     */
    getStatus() {
        return this.status;
    }
    /**
     * Retrieve the exception message
     *
     * @returns message
     */
    getMessage() {
        return this.message;
    }
    /**
     * Encode composite error message for easy validation in unit tests
     *
     * @returns composite error message
     */
    toString() {
        return `AppException: (${this.status}) ${this.message}`;
    }
}
//# sourceMappingURL=app-exception.js.map