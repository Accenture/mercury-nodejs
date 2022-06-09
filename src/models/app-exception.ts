export class AppException extends Error {

    private status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }

    getStatus(): number {
        return this.status;
    }

    getMessage(): string {
        return this.message;
    }

}