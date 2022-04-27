import { NearestPointModel } from "../core/nearestPoint";
import { ResolvedCoreOptions, TimeChartSeriesOptions } from "../options";
import { RenderModel } from "../core/renderModel";
import { TimeChartPlugin } from ".";
declare type ItemElements = {
    item: HTMLElement;
    example: HTMLElement;
    name: HTMLElement;
    value: HTMLElement;
};
export declare class Tooltip {
    private el;
    private model;
    private options;
    private nearestPoint;
    tooltip: HTMLElement;
    xItem: ItemElements;
    items: Map<TimeChartSeriesOptions, ItemElements>;
    itemContainer: HTMLElement;
    constructor(el: HTMLElement, model: RenderModel, options: ResolvedCoreOptions, nearestPoint: NearestPointModel);
    private createItemElements;
    update(): void;
}
export declare const tooltip: TimeChartPlugin<Tooltip>;
export {};
