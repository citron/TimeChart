import core from './core';
import { TimeChartZoomPlugin } from './plugins/chartZoom';
import { crosshair } from './plugins/crosshair';
import { d3Axis } from './plugins/d3Axis';
import { legend } from './plugins/legend';
import { lineChart } from './plugins/lineChart';
import { nearestPoint } from './plugins/nearestPoint';
import { tooltip } from './plugins/tooltip';
function addDefaultPlugins(options) {
    var _a;
    const o = options !== null && options !== void 0 ? options : { plugins: undefined, zoom: undefined };
    return Object.assign(Object.assign({}, options), { plugins: Object.assign(Object.assign({}, ((_a = o.plugins) !== null && _a !== void 0 ? _a : {})), { lineChart,
            d3Axis,
            crosshair,
            nearestPoint,
            legend, zoom: new TimeChartZoomPlugin(o.zoom), tooltip }) });
}
export default class TimeChart extends core {
    constructor(el, options) {
        super(el, addDefaultPlugins(options));
        this.el = el;
    }
    get options() { return this._options; }
}
// For users who use script tag
TimeChart.core = core;
TimeChart.plugins = {
    lineChart,
    d3Axis,
    crosshair,
    nearestPoint,
    legend,
    TimeChartZoomPlugin,
    tooltip
};
//# sourceMappingURL=index.js.map