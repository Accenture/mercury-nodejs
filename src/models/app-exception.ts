export class AppException extends Error {
    
    private status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }

    /**
     * Note that status code should be compliant with the 3-digit numeric HTTP status code convention.
     * i.e. HTTP-2xx for success, HTTP-4xx for application related issues and HTTP-5xx for infrastructure failures.
     * 
     * @returns status code
     */
    getStatus(): number {
        return this.status;
    }

    /**
     * Retrieve the exception message
     * 
     * @returns message
     */
    getMessage(): string {
        return this.message;
    }
}
