export declare class ClassScanUtility {
    static getParams(text: string): Array<string>;
    static list2str(list: Array<string>): string;
}
export declare class TypeScriptClassScanner {
    private readonly sourceFolder;
    private readonly methodAnnotation;
    private clsMap;
    private clsParents;
    private clsParameters;
    private clsMethods;
    constructor(sourceFolder: string, methodAnnotation: string);
    scan(): Promise<{
        classes: {};
        parents: {};
        parameters: {};
        methods: {};
    }>;
    private scanSource;
    private scanSourceCode;
    private parseExportTag;
    private parseInheritance;
    private parseMethod;
}
