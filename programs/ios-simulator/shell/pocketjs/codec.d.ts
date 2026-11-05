export declare function foundationCodec(native: {
  bufferFromData(data: any): ArrayBuffer;
  data(bytes: ArrayBuffer): any;
  number(value: number): any;
  array(values: any[]): any;
  dictionary(values: Record<string, any>): any;
}): {
  arguments(args: {kind: string; value: any}[]): any;
  result(value: any): any;
  environment(value: any): any;
  frame(value: any): any;
};
