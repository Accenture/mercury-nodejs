export declare class ClassScanUtility {
    static getParams(text: string): Array<string>;
    static list2str(list: Array<string>): string;
}
export declare class TypeScriptClassScanner {
    private readonly parentFolder;
    private readonly tsFolder;
    private readonly methodAnnotation;
    private clsMap;
    private clsParents;
    private clsParameters;
    private clsMethods;
    constructor(parentFolder: string, tsFolder: string, methodAnnotation: string);
    scan(): Promise<{
        classes: {};
        parents: {};
        parameters: {};
        methods: {};
    }>;
    private scanSource;
    private scanSourceCode;
    private getAnnotation;
    private parseExportTag;
    private parseInheritance;
    private parseMethod;
}
