import { rgb } from 'd3-color';
import { scaleLinear, scaleTime } from 'd3-scale';
import { axisBottom, axisLeft } from 'd3-axis';
import { select } from 'd3-selection';

function resolveColorRGBA(color) {
    const rgbColor = typeof color === 'string' ? rgb(color) : rgb(color);
    return [rgbColor.r / 255, rgbColor.g / 255, rgbColor.b / 255, rgbColor.opacity];
}

function getContext(canvas, forceWebGL1) {
    if (!forceWebGL1) {
        const ctx = canvas.getContext('webgl2');
        if (ctx) {
            return ctx;
        }
    }
    const ctx = canvas.getContext('webgl');
    if (ctx) {
        return ctx;
    }
    throw new Error('Unable to initialize WebGL. Your browser or machine may not support it.');
}
class CanvasLayer {
    constructor(el, options, model) {
        this.options = options;
        const canvas = document.createElement('canvas');
        const style = canvas.style;
        style.position = 'absolute';
        style.width = style.height = '100%';
        style.left = style.right = style.top = style.bottom = '0';
        el.shadowRoot.appendChild(canvas);
        this.gl = getContext(canvas, options.forceWebGL1);
        const bgColor = resolveColorRGBA(options.backgroundColor);
        this.gl.clearColor(...bgColor);
        this.canvas = canvas;
        model.updated.on(() => {
            this.clear();
            this.syncViewport();
        });
        model.resized.on((w, h) => this.onResize(w, h));
        model.disposing.on(() => {
            el.shadowRoot.removeChild(canvas);
            canvas.width = 0;
            canvas.height = 0;
            const lossContext = this.gl.getExtension('WEBGL_lose_context');
            if (lossContext) {
                lossContext.loseContext();
            }
        });
    }
    syncViewport() {
        const o = this.options;
        const r = o.pixelRatio;
        this.gl.viewport(o.renderPaddingLeft * r, o.renderPaddingBottom * r, (this.canvas.width - (o.renderPaddingLeft + o.renderPaddingRight) * r), (this.canvas.height - (o.renderPaddingTop + o.renderPaddingBottom) * r));
    }
    onResize(width, height) {
        const canvas = this.canvas;
        const scale = this.options.pixelRatio;
        canvas.width = width * scale;
        canvas.height = height * scale;
        this.syncViewport();
    }
    clear() {
        const gl = this.gl;
        gl.clear(gl.COLOR_BUFFER_BIT);
    }
}

class ContentBoxDetector {
    constructor(el, model, options) {
        this.node = document.createElement('div');
        this.node.style.position = 'absolute';
        this.node.style.left = `${options.paddingLeft}px`;
        this.node.style.right = `${options.paddingRight}px`;
        this.node.style.top = `${options.paddingTop}px`;
        this.node.style.bottom = `${options.paddingBottom}px`;
        el.shadowRoot.appendChild(this.node);
        model.disposing.on(() => {
            el.shadowRoot.removeChild(this.node);
        });
    }
}

/** lower bound */
function domainSearch(data, start, end, value, key) {
    if (start >= end) {
        return start;
    }
    if (value <= key(data[start])) {
        return start;
    }
    if (value > key(data[end - 1])) {
        return end;
    }
    end -= 1;
    while (start + 1 < end) {
        const minDomain = key(data[start]);
        const maxDomain = key(data[end]);
        const ratio = maxDomain <= minDomain ? 0 : (value - minDomain) / (maxDomain - minDomain);
        let expectedIndex = Math.ceil(start + ratio * (end - start));
        if (expectedIndex === end)
            expectedIndex--;
        else if (expectedIndex === start)
            expectedIndex++;
        const domain = key(data[expectedIndex]);
        if (domain < value) {
            start = expectedIndex;
        }
        else {
            end = expectedIndex;
        }
    }
    return end;
}
class EventDispatcher {
    constructor() {
        this.callbacks = [];
    }
    on(callback) {
        this.callbacks.push(callback);
    }
    dispatch(...args) {
        for (const cb of this.callbacks) {
            cb(...args);
        }
    }
}

class NearestPointModel {
    constructor(canvas, model, options, detector) {
        this.canvas = canvas;
        this.model = model;
        this.options = options;
        this.dataPoints = new Map();
        this.lastPointerPos = null;
        this.updated = new EventDispatcher();
        detector.node.addEventListener('mousemove', ev => {
            const rect = canvas.canvas.getBoundingClientRect();
            this.lastPointerPos = {
                x: ev.clientX - rect.left,
                y: ev.clientY - rect.top,
            };
            this.adjustPoints();
        });
        detector.node.addEventListener('mouseleave', ev => {
            this.lastPointerPos = null;
            this.adjustPoints();
        });
        model.updated.on(() => this.adjustPoints());
    }
    adjustPoints() {
        if (this.lastPointerPos === null) {
            this.dataPoints.clear();
        }
        else {
            const domain = this.model.xScale.invert(this.lastPointerPos.x);
            for (const s of this.options.series) {
                if (s.data.length == 0 || !s.visible) {
                    this.dataPoints.delete(s);
                    continue;
                }
                const pos = domainSearch(s.data, 0, s.data.length, domain, d => d.x);
                const near = [];
                if (pos > 0) {
                    near.push(s.data[pos - 1]);
                }
                if (pos < s.data.length) {
                    near.push(s.data[pos]);
                }
                const sortKey = (a) => Math.abs(a.x - domain);
                near.sort((a, b) => sortKey(a) - sortKey(b));
                const pxPoint = this.model.pxPoint(near[0]);
                const width = this.canvas.canvas.clientWidth;
                const height = this.canvas.canvas.clientHeight;
                if (pxPoint.x <= width && pxPoint.x >= 0 &&
                    pxPoint.y <= height && pxPoint.y >= 0) {
                    this.dataPoints.set(s, near[0]);
                }
                else {
                    this.dataPoints.delete(s);
                }
            }
        }
        this.updated.dispatch();
    }
}

function calcMinMaxY(arr, start, end) {
    let max = -Infinity;
    let min = Infinity;
    for (let i = start; i < end; i++) {
        const v = arr[i].y;
        if (v > max)
            max = v;
        if (v < min)
            min = v;
    }
    return { max, min };
}
function unionMinMax(...items) {
    return {
        min: Math.min(...items.map(i => i.min)),
        max: Math.max(...items.map(i => i.max)),
    };
}
class RenderModel {
    constructor(options) {
        this.options = options;
        this.xScale = scaleLinear();
        this.yScale = scaleLinear();
        this.xRange = null;
        this.yRange = null;
        this.resized = new EventDispatcher();
        this.updated = new EventDispatcher();
        this.disposing = new EventDispatcher();
        this.disposed = false;
        this.redrawRequested = false;
        if (options.xRange !== 'auto' && options.xRange) {
            this.xScale.domain([options.xRange.min, options.xRange.max]);
        }
        if (options.yRange !== 'auto' && options.yRange) {
            this.yScale.domain([options.yRange.min, options.yRange.max]);
        }
    }
    resize(width, height) {
        const op = this.options;
        this.xScale.range([op.paddingLeft, width - op.paddingRight]);
        this.yScale.range([height - op.paddingBottom, op.paddingTop]);
        this.resized.dispatch(width, height);
        this.requestRedraw();
    }
    dispose() {
        if (!this.disposed) {
            this.disposing.dispatch();
            this.disposed = true;
        }
    }
    update() {
        this.updateModel();
        this.updated.dispatch();
        for (const s of this.options.series) {
            s.data._synced();
        }
    }
    updateModel() {
        const series = this.options.series.filter(s => s.data.length > 0);
        if (series.length === 0) {
            return;
        }
        const o = this.options;
        {
            const maxDomain = Math.max(...series.map(s => s.data[s.data.length - 1].x));
            const minDomain = Math.min(...series.map(s => s.data[0].x));
            this.xRange = { max: maxDomain, min: minDomain };
            if (this.options.realTime || o.xRange === 'auto') {
                if (this.options.realTime) {
                    const currentDomain = this.xScale.domain();
                    const range = currentDomain[1] - currentDomain[0];
                    this.xScale.domain([maxDomain - range, maxDomain]);
                }
                else { // Auto
                    this.xScale.domain([minDomain, maxDomain]);
                }
            }
            else if (o.xRange) {
                this.xScale.domain([o.xRange.min, o.xRange.max]);
            }
        }
        {
            const minMaxY = series.flatMap(s => {
                return [
                    calcMinMaxY(s.data, 0, s.data.pushed_front),
                    calcMinMaxY(s.data, s.data.length - s.data.pushed_back, s.data.length),
                ];
            });
            if (this.yRange) {
                minMaxY.push(this.yRange);
            }
            this.yRange = unionMinMax(...minMaxY);
            if (o.yRange === 'auto') {
                this.yScale.domain([this.yRange.min, this.yRange.max]).nice();
            }
            else if (o.yRange) {
                this.yScale.domain([o.yRange.min, o.yRange.max]);
            }
        }
    }
    requestRedraw() {
        if (this.redrawRequested) {
            return;
        }
        this.redrawRequested = true;
        requestAnimationFrame((time) => {
            this.redrawRequested = false;
            if (!this.disposed) {
                this.update();
            }
        });
    }
    pxPoint(dataPoint) {
        return {
            x: this.xScale(dataPoint.x),
            y: this.yScale(dataPoint.y),
        };
    }
}

class SVGLayer {
    constructor(el, model) {
        this.svgNode = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const style = this.svgNode.style;
        style.position = 'absolute';
        style.width = style.height = '100%';
        style.left = style.right = style.top = style.bottom = '0';
        el.shadowRoot.appendChild(this.svgNode);
        model.disposing.on(() => {
            el.shadowRoot.removeChild(this.svgNode);
        });
    }
}
function makeContentBox(model, options) {
    const contentSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    contentSvg.classList.add('content-box');
    contentSvg.x.baseVal.value = options.paddingLeft;
    contentSvg.y.baseVal.value = options.paddingRight;
    model.resized.on((width, height) => {
        contentSvg.width.baseVal.value = width - options.paddingRight - options.paddingLeft;
        contentSvg.height.baseVal.value = height - options.paddingTop - options.paddingBottom;
    });
    return contentSvg;
}

class DataPointsBuffer extends Array {
    constructor() {
        super(...arguments);
        this.pushed_back = 0;
        this.pushed_front = 0;
        this.poped_back = 0;
        this.poped_front = 0;
        this.pushed_back = this.length;
    }
    _synced() {
        this.pushed_back = this.poped_back = this.pushed_front = this.poped_front = 0;
    }
    static _from_array(arr) {
        if (arr instanceof DataPointsBuffer)
            return arr;
        const b = Object.setPrototypeOf(arr, DataPointsBuffer.prototype);
        b.poped_back = b.pushed_front = b.poped_front = 0;
        b.pushed_back = b.length;
        return b;
    }
    push(...items) {
        this.pushed_back += items.length;
        return super.push(...items);
    }
    pop() {
        const len = this.length;
        const r = super.pop();
        if (r === undefined)
            return r;
        if (this.pushed_back > 0)
            this.pushed_back--;
        else if (len - this.pushed_front > 0)
            this.poped_back++;
        else
            this.pushed_front--;
        return r;
    }
    unshift(...items) {
        this.pushed_front += items.length;
        return super.unshift(...items);
    }
    shift() {
        const len = this.length;
        const r = super.shift();
        if (r === undefined)
            return r;
        if (this.pushed_front > 0)
            this.pushed_front--;
        else if (len - this.pushed_back > 0)
            this.poped_front++;
        else
            this.pushed_back--;
        return r;
    }
    updateDelete(start, deleteCount, len) {
        if (deleteCount === 0)
            return;
        const d = (c) => {
            deleteCount -= c;
            len -= c;
            return deleteCount === 0;
        };
        if (start < this.pushed_front) {
            const c = Math.min(deleteCount, this.pushed_front - start);
            this.pushed_front -= c;
            if (d(c))
                return;
        }
        if (start === this.pushed_front) {
            const c = Math.min(deleteCount, len - this.pushed_front - this.pushed_back);
            this.poped_front += c;
            if (d(c))
                return;
        }
        if (start > this.pushed_front && start < len - this.pushed_back) {
            if (start + deleteCount < len - this.pushed_back)
                throw new RangeError("DataPoints that already synced to GPU cannot be delete in the middle");
            const c = Math.min(deleteCount, len - start - this.pushed_back);
            this.poped_back += c;
            if (d(c))
                return;
        }
        const c = Math.min(deleteCount, len - start);
        this.pushed_back -= c;
        if (d(c))
            return;
        throw new Error('BUG');
    }
    updateInsert(start, insertCount, len) {
        if (start <= this.pushed_front) {
            this.pushed_front += insertCount;
        }
        else if (start >= len - this.pushed_back) {
            this.pushed_back += insertCount;
        }
        else {
            throw new RangeError("DataPoints cannot be inserted in the middle of the range that is already synced to GPU");
        }
    }
    splice(start, deleteCount, ...items) {
        if (start === -Infinity)
            start = 0;
        else if (start < 0)
            start = Math.max(this.length + start, 0);
        if (deleteCount === undefined)
            deleteCount = this.length - start;
        else
            deleteCount = Math.min(Math.max(deleteCount, 0), this.length - start);
        this.updateDelete(start, deleteCount, this.length);
        this.updateInsert(start, items.length, this.length - deleteCount);
        const expectedLen = this.length - deleteCount + items.length;
        const r = super.splice(start, deleteCount, ...items);
        if (this.length !== expectedLen)
            throw new Error(`BUG! length after splice not expected. ${this.length} vs ${expectedLen}`);
        return r;
    }
}

const defaultOptions = {
    pixelRatio: window.devicePixelRatio,
    lineWidth: 1,
    backgroundColor: rgb(0, 0, 0, 0),
    paddingTop: 10,
    paddingRight: 10,
    paddingLeft: 45,
    paddingBottom: 20,
    renderPaddingTop: 0,
    renderPaddingRight: 0,
    renderPaddingLeft: 0,
    renderPaddingBottom: 0,
    xRange: 'auto',
    yRange: 'auto',
    realTime: false,
    baseTime: 0,
    xScaleType: scaleTime,
    debugWebGL: false,
    forceWebGL1: false,
    legend: true,
    tooltip: false,
    tooltipXLabel: "X"
};
const defaultSeriesOptions = {
    name: '',
    color: null,
    visible: true,
};
function completeSeriesOptions(s) {
    s.data = s.data ? DataPointsBuffer._from_array(s.data) : new DataPointsBuffer();
    Object.setPrototypeOf(s, defaultSeriesOptions);
    return s;
}
function completeOptions(el, options) {
    const dynamicDefaults = {
        series: [],
        color: getComputedStyle(el).getPropertyValue('color'),
    };
    const o = Object.assign({}, dynamicDefaults, options);
    o.series = o.series.map(s => completeSeriesOptions(s));
    Object.setPrototypeOf(o, defaultOptions);
    return o;
}
class TimeChart$1 {
    constructor(el, options) {
        var _a, _b;
        this.el = el;
        this.disposed = false;
        const coreOptions = completeOptions(el, options);
        this.model = new RenderModel(coreOptions);
        const shadowRoot = (_a = el.shadowRoot) !== null && _a !== void 0 ? _a : el.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.innerText = `
:host {
    contain: size layout paint style;
    position: relative;
}`;
        shadowRoot.appendChild(style);
        this.canvasLayer = new CanvasLayer(el, coreOptions, this.model);
        this.svgLayer = new SVGLayer(el, this.model);
        this.contentBoxDetector = new ContentBoxDetector(el, this.model, coreOptions);
        this.nearestPoint = new NearestPointModel(this.canvasLayer, this.model, coreOptions, this.contentBoxDetector);
        this._options = coreOptions;
        this.plugins = Object.fromEntries(Object.entries((_b = options === null || options === void 0 ? void 0 : options.plugins) !== null && _b !== void 0 ? _b : {}).map(([name, p]) => [name, p.apply(this)]));
        this.onResize();
        const resizeHandler = () => this.onResize();
        window.addEventListener('resize', resizeHandler);
        this.model.disposing.on(() => {
            window.removeEventListener('resize', resizeHandler);
            shadowRoot.removeChild(style);
        });
    }
    get options() { return this._options; }
    onResize() {
        this.model.resize(this.el.clientWidth, this.el.clientHeight);
    }
    update() {
        if (this.disposed) {
            throw new Error('Cannot update after dispose.');
        }
        // fix dynamic added series
        for (let i = 0; i < this.options.series.length; i++) {
            const s = this.options.series[i];
            if (!defaultSeriesOptions.isPrototypeOf(s)) {
                this.options.series[i] = completeSeriesOptions(s);
            }
        }
        this.model.requestRedraw();
    }
    dispose() {
        this.model.dispose();
        this.disposed = true;
    }
}

var DIRECTION;
(function (DIRECTION) {
    DIRECTION[DIRECTION["UNKNOWN"] = 0] = "UNKNOWN";
    DIRECTION[DIRECTION["X"] = 1] = "X";
    DIRECTION[DIRECTION["Y"] = 2] = "Y";
})(DIRECTION || (DIRECTION = {}));
function dirOptions(options) {
    return [
        { dir: DIRECTION.X, op: options.x },
        { dir: DIRECTION.Y, op: options.y },
    ].filter(i => i.op !== undefined);
}

function zip(...rows) {
    return [...rows[0]].map((_, c) => rows.map(row => row[c]));
}
/**
 * least squares
 *
 * beta^T = [b, k]
 * X = [[1, x_1],
 *      [1, x_2],
 *      [1, x_3], ...]
 * Y^T = [y_1, y_2, y_3, ...]
 * beta = (X^T X)^(-1) X^T Y
 * @returns `{k, b}`
 */
function linearRegression(data) {
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    const len = data.length;
    for (const p of data) {
        sumX += p.x;
        sumY += p.y;
        sumXY += p.x * p.y;
        sumXX += p.x * p.x;
    }
    const det = (len * sumXX) - (sumX * sumX);
    const k = det === 0 ? 0 : ((len * sumXY) - (sumX * sumY)) / det;
    const b = (sumY - k * sumX) / len;
    return { k, b };
}
function scaleK(scale) {
    const domain = scale.domain();
    const range = scale.range();
    return (domain[1] - domain[0]) / (range[1] - range[0]);
}
/**
 * @returns If domain changed
 */
function applyNewDomain(op, domain) {
    const inExtent = domain[1] - domain[0];
    const previousDomain = op.scale.domain();
    if ((previousDomain[1] - previousDomain[0]) * inExtent <= 0) {
        // forbidden reverse direction.
        return false;
    }
    const extent = Math.min(op.maxDomainExtent, op.maxDomain - op.minDomain, Math.max(op.minDomainExtent, inExtent));
    const deltaE = (extent - inExtent) / 2;
    domain[0] -= deltaE;
    domain[1] += deltaE;
    const deltaO = Math.min(Math.max(op.minDomain - domain[0], 0), op.maxDomain - domain[1]);
    domain[0] += deltaO;
    domain[1] += deltaO;
    const eps = extent * 1e-6;
    op.scale.domain(domain);
    if (zip(domain, previousDomain).some(([d, pd]) => Math.abs(d - pd) > eps)) {
        return true;
    }
    return false;
}
function variance(data) {
    const mean = data.reduce((a, b) => a + b) / data.length;
    return data.map(d => (d - mean) ** 2).reduce((a, b) => a + b) / data.length;
}
function clamp(value, min, max) {
    if (value > max) {
        return max;
    }
    else if (value < min) {
        return min;
    }
    return value;
}

class ChartZoomMouse {
    constructor(el, options) {
        this.el = el;
        this.options = options;
        this.scaleUpdated = new EventDispatcher();
        this.previousPoint = null;
        el.style.userSelect = 'none';
        el.addEventListener('pointerdown', ev => this.onMouseDown(ev));
        el.addEventListener('pointerup', ev => this.onMouseUp(ev));
        el.addEventListener('pointermove', ev => this.onMouseMove(ev));
    }
    point(ev) {
        const boundingRect = this.el.getBoundingClientRect();
        return {
            [DIRECTION.X]: ev.clientX - boundingRect.left,
            [DIRECTION.Y]: ev.clientY - boundingRect.top,
        };
    }
    onMouseMove(event) {
        if (this.previousPoint === null) {
            return;
        }
        const p = this.point(event);
        let changed = false;
        for (const { dir, op } of dirOptions(this.options)) {
            const offset = p[dir] - this.previousPoint[dir];
            const k = scaleK(op.scale);
            const domain = op.scale.domain();
            const newDomain = domain.map(d => d - k * offset);
            if (applyNewDomain(op, newDomain)) {
                changed = true;
            }
        }
        this.previousPoint = p;
        if (changed) {
            this.scaleUpdated.dispatch();
        }
    }
    onMouseDown(event) {
        if (event.pointerType !== 'mouse') {
            return;
        }
        this.el.setPointerCapture(event.pointerId);
        this.previousPoint = this.point(event);
        this.el.style.cursor = 'grabbing';
    }
    onMouseUp(event) {
        if (this.previousPoint === null) {
            return;
        }
        this.previousPoint = null;
        this.el.releasePointerCapture(event.pointerId);
        this.el.style.cursor = '';
    }
}

class ChartZoomTouch {
    constructor(el, options) {
        this.el = el;
        this.options = options;
        this.scaleUpdated = new EventDispatcher();
        this.majorDirection = DIRECTION.UNKNOWN;
        this.previousPoints = new Map();
        this.enabled = {
            [DIRECTION.X]: false,
            [DIRECTION.Y]: false,
        };
        el.addEventListener('touchstart', e => this.onTouchStart(e), { passive: true });
        el.addEventListener('touchend', e => this.onTouchEnd(e), { passive: true });
        el.addEventListener('touchcancel', e => this.onTouchEnd(e), { passive: true });
        el.addEventListener('touchmove', e => this.onTouchMove(e), { passive: true });
        this.update();
    }
    update() {
        this.syncEnabled();
        this.syncTouchAction();
    }
    syncEnabled() {
        for (const { dir, op } of dirOptions(this.options)) {
            if (!op) {
                this.enabled[dir] = false;
            }
            else {
                const domain = op.scale.domain().sort();
                this.enabled[dir] = op.minDomain < domain[0] && domain[1] < op.maxDomain;
            }
        }
    }
    syncTouchAction() {
        const actions = [];
        if (!this.enabled[DIRECTION.X]) {
            actions.push('pan-x');
        }
        if (!this.enabled[DIRECTION.Y]) {
            actions.push('pan-y');
        }
        if (actions.length === 0) {
            actions.push('none');
        }
        this.el.style.touchAction = actions.join(' ');
    }
    calcKB(dir, op, data) {
        if (dir === this.majorDirection && data.length >= 2) {
            const domain = op.scale.domain();
            const extent = domain[1] - domain[0];
            if (variance(data.map(d => d.domain)) > 1e-4 * extent * extent) {
                return linearRegression(data.map(t => ({ x: t.current, y: t.domain })));
            }
        }
        // Pan only
        const k = scaleK(op.scale);
        const b = data.map(t => t.domain - k * t.current).reduce((a, b) => a + b) / data.length;
        return { k, b };
    }
    touchPoints(touches) {
        const boundingBox = this.el.getBoundingClientRect();
        const ts = new Map([...touches].map(t => [t.identifier, {
                [DIRECTION.X]: t.clientX - boundingBox.left,
                [DIRECTION.Y]: t.clientY - boundingBox.top,
            }]));
        let changed = false;
        for (const { dir, op } of dirOptions(this.options)) {
            const scale = op.scale;
            const temp = [...ts.entries()].map(([id, p]) => ({ current: p[dir], previousPoint: this.previousPoints.get(id) }))
                .filter(t => t.previousPoint !== undefined)
                .map(({ current, previousPoint }) => ({ current, domain: scale.invert(previousPoint[dir]) }));
            if (temp.length === 0) {
                continue;
            }
            const { k, b } = this.calcKB(dir, op, temp);
            const domain = scale.range().map(r => b + k * r);
            if (applyNewDomain(op, domain)) {
                changed = true;
            }
        }
        this.previousPoints = ts;
        if (changed) {
            this.scaleUpdated.dispatch();
        }
        return changed;
    }
    dirOptions(dir) {
        return {
            [DIRECTION.X]: this.options.x,
            [DIRECTION.Y]: this.options.y,
        }[dir];
    }
    onTouchStart(event) {
        if (this.majorDirection === DIRECTION.UNKNOWN && event.touches.length >= 2) {
            const ts = [...event.touches];
            function vari(data) {
                const mean = data.reduce((a, b) => a + b) / data.length;
                return data.map(d => (d - mean) ** 2).reduce((a, b) => a + b);
            }
            const varX = vari(ts.map(t => t.clientX));
            const varY = vari(ts.map(t => t.clientY));
            this.majorDirection = varX > varY ? DIRECTION.X : DIRECTION.Y;
            if (this.dirOptions(this.majorDirection) === undefined) {
                this.majorDirection = DIRECTION.UNKNOWN;
            }
        }
        this.touchPoints(event.touches);
    }
    onTouchEnd(event) {
        if (event.touches.length < 2) {
            this.majorDirection = DIRECTION.UNKNOWN;
        }
        this.touchPoints(event.touches);
    }
    onTouchMove(event) {
        this.touchPoints(event.touches);
    }
}

class ChartZoomWheel {
    constructor(el, options) {
        this.el = el;
        this.options = options;
        this.scaleUpdated = new EventDispatcher();
        el.addEventListener('wheel', ev => this.onWheel(ev));
    }
    onWheel(event) {
        event.preventDefault();
        let deltaX = event.deltaX;
        let deltaY = event.deltaY;
        switch (event.deltaMode) {
            case 1: // line
                deltaX *= 30;
                deltaY *= 30;
                break;
            case 2: // page
                deltaX *= 400;
                deltaY *= 400;
                break;
        }
        const transform = {
            [DIRECTION.X]: {
                translate: 0,
                zoom: 0,
            },
            [DIRECTION.Y]: {
                translate: 0,
                zoom: 0,
            }
        };
        if (event.ctrlKey) { // zoom
            if (event.altKey) {
                transform[DIRECTION.X].zoom = deltaX;
                transform[DIRECTION.Y].zoom = deltaY;
            }
            else {
                transform[DIRECTION.X].zoom = (deltaX + deltaY);
            }
        }
        else { // translate
            if (event.altKey) {
                transform[DIRECTION.X].translate = deltaX;
                transform[DIRECTION.Y].translate = deltaY;
            }
            else {
                transform[DIRECTION.X].translate = (deltaX + deltaY);
            }
        }
        const boundingRect = this.el.getBoundingClientRect();
        const origin = {
            [DIRECTION.X]: event.clientX - boundingRect.left,
            [DIRECTION.Y]: event.clientY - boundingRect.top,
        };
        let changed = false;
        for (const { dir, op } of dirOptions(this.options)) {
            const domain = op.scale.domain();
            const k = scaleK(op.scale);
            const trans = transform[dir];
            const transOrigin = op.scale.invert(origin[dir]);
            trans.translate *= k;
            trans.zoom *= 0.002;
            if (event.shiftKey) {
                trans.translate *= 5;
                trans.zoom *= 5;
            }
            const extent = domain[1] - domain[0];
            const translateCap = 0.4 * extent;
            trans.translate = clamp(trans.translate, -translateCap, translateCap);
            const zoomCap = 0.5;
            trans.zoom = clamp(trans.zoom, -zoomCap, zoomCap);
            const newDomain = domain.map(d => d + trans.translate + (d - transOrigin) * trans.zoom);
            if (applyNewDomain(op, newDomain)) {
                changed = true;
            }
        }
        if (changed) {
            this.scaleUpdated.dispatch();
        }
    }
}

const defaultAxisOptions = {
    minDomain: -Infinity,
    maxDomain: Infinity,
    minDomainExtent: 0,
    maxDomainExtent: Infinity,
};
function resolveOptions(defaults, o) {
    if (!o)
        o = {};
    const resolveAxis = (ao) => {
        if (ao && !defaults.isPrototypeOf(ao))
            Object.setPrototypeOf(ao, defaults);
    };
    resolveAxis(o.x);
    resolveAxis(o.y);
    return o;
}
class ChartZoom {
    constructor(el, options) {
        this.scaleUpdated = new EventDispatcher();
        options = options !== null && options !== void 0 ? options : {};
        this.options = resolveOptions(defaultAxisOptions, options);
        this.touch = new ChartZoomTouch(el, this.options);
        this.mouse = new ChartZoomMouse(el, this.options);
        this.wheel = new ChartZoomWheel(el, this.options);
        const cb = () => this.scaleUpdated.dispatch();
        this.touch.scaleUpdated.on(cb);
        this.mouse.scaleUpdated.on(cb);
        this.wheel.scaleUpdated.on(cb);
    }
    onScaleUpdated(callback) {
        this.scaleUpdated.on(callback);
    }
    /** Call this when scale updated outside */
    update() {
        this.touch.update();
    }
}

class TimeChartZoom {
    constructor(chart, options) {
        this.options = options;
        this.registerZoom(chart);
    }
    applyAutoRange(o, dataRange) {
        if (!o)
            return;
        if (!o.autoRange) {
            delete o.minDomain;
            delete o.maxDomain;
            return;
        }
        let [min, max] = o.scale.domain();
        if (dataRange) {
            min = Math.min(min, dataRange.min);
            max = Math.max(max, dataRange.max);
        }
        o.minDomain = min;
        o.maxDomain = max;
    }
    registerZoom(chart) {
        const z = new ChartZoom(chart.contentBoxDetector.node, {
            x: this.options.x && Object.assign(Object.create(this.options.x), { scale: chart.model.xScale }),
            y: this.options.y && Object.assign(Object.create(this.options.y), { scale: chart.model.yScale }),
        });
        const o = z.options;
        chart.model.updated.on(() => {
            this.applyAutoRange(o.x, chart.model.xRange);
            this.applyAutoRange(o.y, chart.model.yRange);
            z.update();
        });
        z.onScaleUpdated(() => {
            chart.options.xRange = null;
            chart.options.yRange = null;
            chart.options.realTime = false;
            chart.update();
        });
    }
}
const defaults = Object.assign(Object.create(defaultAxisOptions), {
    autoRange: true,
});
class TimeChartZoomPlugin {
    constructor(o) {
        this.options = resolveOptions(defaults, o);
    }
    apply(chart) {
        return new TimeChartZoom(chart, this.options);
    }
}

const crosshair = {
    apply(chart) {
        const contentBox = makeContentBox(chart.model, chart.options);
        const initTrans = contentBox.createSVGTransform();
        initTrans.setTranslate(0, 0);
        const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
        style.textContent = `
.timechart-crosshair {
    stroke: currentColor;
    stroke-width: 1;
    stroke-dasharray: 2 1;
    visibility: hidden;
}`;
        const hLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        hLine.transform.baseVal.initialize(initTrans);
        hLine.x2.baseVal.newValueSpecifiedUnits(SVGLength.SVG_LENGTHTYPE_PERCENTAGE, 100);
        const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        vLine.transform.baseVal.initialize(initTrans);
        vLine.y2.baseVal.newValueSpecifiedUnits(SVGLength.SVG_LENGTHTYPE_PERCENTAGE, 100);
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.classList.add('timechart-crosshair');
        for (const e of [style, hLine, vLine]) {
            g.appendChild(e);
        }
        const detector = chart.contentBoxDetector;
        detector.node.addEventListener('mousemove', ev => {
            const contentRect = contentBox.getBoundingClientRect();
            hLine.transform.baseVal.getItem(0).setTranslate(0, ev.clientY - contentRect.y);
            vLine.transform.baseVal.getItem(0).setTranslate(ev.clientX - contentRect.x, 0);
        });
        detector.node.addEventListener('mouseenter', ev => g.style.visibility = 'visible');
        detector.node.addEventListener('mouseleave', ev => g.style.visibility = 'hidden');
        contentBox.appendChild(g);
        chart.svgLayer.svgNode.appendChild(contentBox);
    }
};

const d3Axis = {
    apply(chart) {
        const d3Svg = select(chart.svgLayer.svgNode);
        const xg = d3Svg.append('g');
        const yg = d3Svg.append('g');
        const xAxis = axisBottom(chart.model.xScale);
        const yAxis = axisLeft(chart.model.yScale);
        function update() {
            const xs = chart.model.xScale;
            const xts = chart.options.xScaleType()
                .domain(xs.domain().map(d => d + chart.options.baseTime))
                .range(xs.range());
            xAxis.scale(xts);
            xg.call(xAxis);
            yAxis.scale(chart.model.yScale);
            yg.call(yAxis);
        }
        chart.model.updated.on(update);
        chart.model.resized.on((w, h) => {
            const op = chart.options;
            xg.attr('transform', `translate(0, ${h - op.paddingBottom})`);
            yg.attr('transform', `translate(${op.paddingLeft}, 0)`);
            update();
        });
    }
};

class Legend {
    constructor(el, model, options) {
        this.el = el;
        this.model = model;
        this.options = options;
        this.items = new Map();
        this.legend = document.createElement('chart-legend');
        const ls = this.legend.style;
        ls.position = 'absolute';
        ls.right = `${options.paddingRight}px`;
        ls.top = `${options.paddingTop}px`;
        const legendRoot = this.legend.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
:host {
    background: var(--background-overlay, white);
    border: 1px solid hsl(0, 0%, 80%);
    border-radius: 3px;
    padding: 5px 10px;
}
.item {
    display: flex;
    flex-flow: row nowrap;
    align-items: center;
    user-select: none;
}
.item:not(.visible) {
    color: gray;
    text-decoration: line-through;
}
.item .example {
    width: 50px;
    margin-right: 10px;
    max-height: 1em;
}`;
        legendRoot.appendChild(style);
        this.itemContainer = legendRoot;
        this.update();
        const shadowRoot = el.shadowRoot;
        shadowRoot.appendChild(this.legend);
        model.updated.on(() => this.update());
        model.disposing.on(() => {
            shadowRoot.removeChild(this.legend);
        });
    }
    update() {
        var _a, _b;
        this.legend.style.display = this.options.legend ? "" : "none";
        if (!this.options.legend)
            return;
        for (const s of this.options.series) {
            if (!this.items.has(s)) {
                const item = document.createElement('div');
                item.className = 'item';
                const example = document.createElement('div');
                example.className = 'example';
                item.appendChild(example);
                const name = document.createElement('label');
                name.textContent = s.name;
                item.appendChild(name);
                this.itemContainer.appendChild(item);
                item.addEventListener('click', (ev) => {
                    s.visible = !s.visible;
                    this.model.update();
                });
                this.items.set(s, { item, example });
            }
            const item = this.items.get(s);
            item.item.classList.toggle('visible', s.visible);
            item.example.style.height = `${(_a = s.lineWidth) !== null && _a !== void 0 ? _a : this.options.lineWidth}px`;
            item.example.style.backgroundColor = ((_b = s.color) !== null && _b !== void 0 ? _b : this.options.color).toString();
        }
    }
}
const legend = {
    apply(chart) {
        return new Legend(chart.el, chart.model, chart.options);
    }
};

/**
 * Common utilities
 * @module glMatrix
 */
var ARRAY_TYPE = typeof Float32Array !== 'undefined' ? Float32Array : Array;
if (!Math.hypot) Math.hypot = function () {
  var y = 0,
      i = arguments.length;

  while (i--) {
    y += arguments[i] * arguments[i];
  }

  return Math.sqrt(y);
};

/**
 * 2 Dimensional Vector
 * @module vec2
 */

/**
 * Creates a new, empty vec2
 *
 * @returns {vec2} a new 2D vector
 */

function create() {
  var out = new ARRAY_TYPE(2);

  if (ARRAY_TYPE != Float32Array) {
    out[0] = 0;
    out[1] = 0;
  }

  return out;
}
/**
 * Creates a new vec2 initialized with the given values
 *
 * @param {Number} x X component
 * @param {Number} y Y component
 * @returns {vec2} a new 2D vector
 */

function fromValues(x, y) {
  var out = new ARRAY_TYPE(2);
  out[0] = x;
  out[1] = y;
  return out;
}
/**
 * Subtracts vector b from vector a
 *
 * @param {vec2} out the receiving vector
 * @param {ReadonlyVec2} a the first operand
 * @param {ReadonlyVec2} b the second operand
 * @returns {vec2} out
 */

function subtract(out, a, b) {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  return out;
}
/**
 * Divides two vec2's
 *
 * @param {vec2} out the receiving vector
 * @param {ReadonlyVec2} a the first operand
 * @param {ReadonlyVec2} b the second operand
 * @returns {vec2} out
 */

function divide(out, a, b) {
  out[0] = a[0] / b[0];
  out[1] = a[1] / b[1];
  return out;
}
/**
 * Negates the components of a vec2
 *
 * @param {vec2} out the receiving vector
 * @param {ReadonlyVec2} a vector to negate
 * @returns {vec2} out
 */

function negate(out, a) {
  out[0] = -a[0];
  out[1] = -a[1];
  return out;
}
/**
 * Normalize a vec2
 *
 * @param {vec2} out the receiving vector
 * @param {ReadonlyVec2} a vector to normalize
 * @returns {vec2} out
 */

function normalize(out, a) {
  var x = a[0],
      y = a[1];
  var len = x * x + y * y;

  if (len > 0) {
    //TODO: evaluate use of glm_invsqrt here?
    len = 1 / Math.sqrt(len);
  }

  out[0] = a[0] * len;
  out[1] = a[1] * len;
  return out;
}
/**
 * Perform some operation over an array of vec2s.
 *
 * @param {Array} a the array of vectors to iterate over
 * @param {Number} stride Number of elements between the start of each vec2. If 0 assumes tightly packed
 * @param {Number} offset Number of elements to skip at the beginning of the array
 * @param {Number} count Number of vec2s to iterate over. If 0 iterates over entire array
 * @param {Function} fn Function to call for each vector in the array
 * @param {Object} [arg] additional argument to pass to fn
 * @returns {Array} a
 * @function
 */

(function () {
  var vec = create();
  return function (a, stride, offset, count, fn, arg) {
    var i, l;

    if (!stride) {
      stride = 2;
    }

    if (!offset) {
      offset = 0;
    }

    if (count) {
      l = Math.min(count * stride + offset, a.length);
    } else {
      l = a.length;
    }

    for (i = offset; i < l; i += stride) {
      vec[0] = a[i];
      vec[1] = a[i + 1];
      fn(vec, vec, arg);
      a[i] = vec[0];
      a[i + 1] = vec[1];
    }

    return a;
  };
})();

class LinkedWebGLProgram {
    constructor(gl, vertexSource, fragmentSource, debug) {
        this.gl = gl;
        this.debug = debug;
        const program = throwIfFalsy(gl.createProgram());
        gl.attachShader(program, throwIfFalsy(createShader(gl, gl.VERTEX_SHADER, vertexSource, debug)));
        gl.attachShader(program, throwIfFalsy(createShader(gl, gl.FRAGMENT_SHADER, fragmentSource, debug)));
        this.program = program;
    }
    link() {
        var _a;
        const gl = this.gl;
        const program = this.program;
        gl.linkProgram(program);
        if (this.debug) {
            const success = gl.getProgramParameter(program, gl.LINK_STATUS);
            if (!success) {
                const message = (_a = gl.getProgramInfoLog(program)) !== null && _a !== void 0 ? _a : 'Unknown Error.';
                gl.deleteProgram(program);
                throw new Error(message);
            }
        }
    }
    use() {
        this.gl.useProgram(this.program);
    }
}
function createShader(gl, type, source, debug) {
    var _a;
    const shader = throwIfFalsy(gl.createShader(type));
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (debug) {
        const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
        if (!success) {
            const message = (_a = gl.getShaderInfoLog(shader)) !== null && _a !== void 0 ? _a : 'Unknown Error.';
            gl.deleteShader(shader);
            throw new Error(message);
        }
    }
    return shader;
}
function throwIfFalsy(value) {
    if (!value) {
        throw new Error('value must not be falsy');
    }
    return value;
}

function vsSource(gl) {
    const body = `
uniform vec2 uModelScale;
uniform vec2 uModelTranslation;
uniform vec2 uProjectionScale;
uniform float uLineWidth;

void main() {
    vec2 cssPose = uModelScale * aDataPoint + uModelTranslation;
    vec2 dir = uModelScale * aDir;
    dir = normalize(dir);
    vec2 pos2d = uProjectionScale * (cssPose + vec2(-dir.y, dir.x) * uLineWidth);
    gl_Position = vec4(pos2d, 0, 1);
}`;
    if (gl instanceof WebGLRenderingContext) {
        return `
attribute vec2 aDataPoint;
attribute vec2 aDir;
${body}`;
    }
    else {
        return `#version 300 es
layout (location = ${0 /* DATA_POINT */}) in vec2 aDataPoint;
layout (location = ${1 /* DIR */}) in vec2 aDir;
${body}`;
    }
}
function fsSource(gl) {
    if (gl instanceof WebGLRenderingContext) {
        return `
precision lowp float;
uniform vec4 uColor;
void main() {
    gl_FragColor = uColor;
}`;
    }
    else {
        return `#version 300 es
precision lowp float;
uniform vec4 uColor;
out vec4 outColor;
void main() {
    outColor = uColor;
}`;
    }
}
class LineChartWebGLProgram extends LinkedWebGLProgram {
    constructor(gl, debug) {
        super(gl, vsSource(gl), fsSource(gl), debug);
        if (gl instanceof WebGLRenderingContext) {
            gl.bindAttribLocation(this.program, 0 /* DATA_POINT */, 'aDataPoint');
            gl.bindAttribLocation(this.program, 1 /* DIR */, 'aDir');
        }
        this.link();
        const getLoc = (name) => throwIfFalsy(gl.getUniformLocation(this.program, name));
        this.locations = {
            uModelScale: getLoc('uModelScale'),
            uModelTranslation: getLoc('uModelTranslation'),
            uProjectionScale: getLoc('uProjectionScale'),
            uLineWidth: getLoc('uLineWidth'),
            uColor: getLoc('uColor'),
        };
    }
}
const INDEX_PER_POINT = 4;
const POINT_PER_DATAPOINT = 4;
const BYTES_PER_POINT = INDEX_PER_POINT * Float32Array.BYTES_PER_ELEMENT;
const BUFFER_DATA_POINT_CAPACITY = 128 * 1024;
const BUFFER_POINT_CAPACITY = BUFFER_DATA_POINT_CAPACITY * POINT_PER_DATAPOINT + 2;
const BUFFER_CAPACITY = BUFFER_POINT_CAPACITY * INDEX_PER_POINT;
class WebGL2VAO {
    constructor(gl) {
        this.gl = gl;
        this.vao = throwIfFalsy(gl.createVertexArray());
        this.bind();
    }
    bind() {
        this.gl.bindVertexArray(this.vao);
    }
    clear() {
        this.gl.deleteVertexArray(this.vao);
    }
}
class OESVAO {
    constructor(vaoExt) {
        this.vaoExt = vaoExt;
        this.vao = throwIfFalsy(vaoExt.createVertexArrayOES());
        this.bind();
    }
    bind() {
        this.vaoExt.bindVertexArrayOES(this.vao);
    }
    clear() {
        this.vaoExt.deleteVertexArrayOES(this.vao);
    }
}
class WebGL1BufferInfo {
    constructor(bindFunc) {
        this.bindFunc = bindFunc;
    }
    bind() {
        this.bindFunc();
    }
    clear() {
    }
}
class SeriesSegmentVertexArray {
    constructor(gl, dataPoints) {
        this.gl = gl;
        this.dataPoints = dataPoints;
        this.validStart = 0;
        this.validEnd = 0;
        this.dataBuffer = throwIfFalsy(gl.createBuffer());
        const bindFunc = () => {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.dataBuffer);
            gl.enableVertexAttribArray(0 /* DATA_POINT */);
            gl.vertexAttribPointer(0 /* DATA_POINT */, 2, gl.FLOAT, false, BYTES_PER_POINT, 0);
            gl.enableVertexAttribArray(1 /* DIR */);
            gl.vertexAttribPointer(1 /* DIR */, 2, gl.FLOAT, false, BYTES_PER_POINT, 2 * Float32Array.BYTES_PER_ELEMENT);
        };
        if (gl instanceof WebGLRenderingContext) {
            const vaoExt = gl.getExtension('OES_vertex_array_object');
            if (vaoExt) {
                this.vao = new OESVAO(vaoExt);
            }
            else {
                this.vao = new WebGL1BufferInfo(bindFunc);
            }
        }
        else {
            this.vao = new WebGL2VAO(gl);
        }
        bindFunc();
        gl.bufferData(gl.ARRAY_BUFFER, BUFFER_CAPACITY * Float32Array.BYTES_PER_ELEMENT, gl.DYNAMIC_DRAW);
    }
    clear() {
        this.validStart = this.validEnd = 0;
    }
    delete() {
        this.clear();
        this.gl.deleteBuffer(this.dataBuffer);
        this.vao.clear();
    }
    /** pop 0 means just remove the overflow
     *
     * @returns Number of datapoints remaining to be removed. Or less than 0 if all removing finished
     */
    popBack(n) {
        const newVaildEndDP = Math.floor(this.validEnd / POINT_PER_DATAPOINT) - n;
        this.validEnd = Math.max(newVaildEndDP * POINT_PER_DATAPOINT, this.validStart);
        return Math.floor(this.validStart / POINT_PER_DATAPOINT) - newVaildEndDP;
    }
    popFront(n) {
        const newVaildStartDP = Math.floor(this.validStart / POINT_PER_DATAPOINT) + n;
        this.validStart = Math.min(newVaildStartDP * POINT_PER_DATAPOINT, this.validEnd);
        return newVaildStartDP - Math.floor(this.validEnd / POINT_PER_DATAPOINT);
    }
    syncPoints(start, bufferStart, bufferEnd) {
        const dataPoints = this.dataPoints;
        const n = bufferEnd - bufferStart;
        const buffer = new Float32Array(n * INDEX_PER_POINT);
        let bi = 0;
        const vDP = create();
        const vPreviousDP = create();
        const dir1 = create();
        const dir2 = create();
        function calc(dp, previousDP) {
            vDP[0] = dp.x;
            vDP[1] = dp.y;
            vPreviousDP[0] = previousDP.x;
            vPreviousDP[1] = previousDP.y;
            subtract(dir1, vDP, vPreviousDP);
            normalize(dir1, dir1);
            negate(dir2, dir1);
        }
        function put(v) {
            buffer[bi] = v[0];
            buffer[bi + 1] = v[1];
            bi += 2;
        }
        const numDPtoAdd = Math.floor(n / POINT_PER_DATAPOINT);
        let previousDP = dataPoints[start - 1];
        for (let i = 0; i < numDPtoAdd; i++) {
            const dp = dataPoints[start + i];
            calc(dp, previousDP);
            previousDP = dp;
            put(vPreviousDP);
            put(dir1);
            put(vPreviousDP);
            put(dir2);
            put(vDP);
            put(dir1);
            put(vDP);
            put(dir2);
        }
        if (bi < buffer.length) { // Overflow
            calc(dataPoints[start + numDPtoAdd], previousDP);
            put(vPreviousDP);
            put(dir1);
            put(vPreviousDP);
            put(dir2);
        }
        if (bi !== buffer.length)
            throw Error('BUG!');
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.dataBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, BYTES_PER_POINT * bufferStart, buffer);
    }
    /**
     * @returns Number of datapoints remaining to be added.
     */
    pushBack(n) {
        if (this.validStart === this.validEnd)
            this.validStart = this.validEnd = 0;
        const oldValidEnd = this.validEnd;
        this.validEnd = Math.min(BUFFER_POINT_CAPACITY, this.validEnd + n * POINT_PER_DATAPOINT);
        const numDPtoAdd = Math.floor((this.validEnd - oldValidEnd) / POINT_PER_DATAPOINT);
        this.syncPoints(this.dataPoints.length - n, oldValidEnd, this.validEnd);
        return n - numDPtoAdd;
    }
    pushFront(n) {
        if (this.validStart === this.validEnd)
            this.validStart = this.validEnd = BUFFER_POINT_CAPACITY;
        const oldVaildStart = this.validStart;
        this.validStart = Math.max(0, (Math.floor(this.validStart / POINT_PER_DATAPOINT) - n) * POINT_PER_DATAPOINT);
        const numDPtoAdd = Math.floor((oldVaildStart - this.validStart) / POINT_PER_DATAPOINT);
        this.syncPoints(n - numDPtoAdd + 1, this.validStart, oldVaildStart);
        return n - numDPtoAdd;
    }
    draw(renderIndex) {
        const first = Math.max(this.validStart, renderIndex.min * POINT_PER_DATAPOINT);
        const last = Math.min(this.validEnd, renderIndex.max * POINT_PER_DATAPOINT);
        const count = last - first;
        const gl = this.gl;
        this.vao.bind();
        gl.drawArrays(gl.TRIANGLE_STRIP, first, count);
        return Math.floor(count / POINT_PER_DATAPOINT);
    }
}
/**
 * An array of `SeriesSegmentVertexArray` to represent a series
 *
 * `series.data[0]` is not part of any VertexArray.
 */
class SeriesVertexArray {
    constructor(gl, series) {
        this.gl = gl;
        this.series = series;
        this.vertexArrays = [];
    }
    popFront() {
        let numDPtoDelete = this.series.data.poped_front;
        if (numDPtoDelete === 0)
            return;
        while (true) {
            const activeArray = this.vertexArrays[0];
            numDPtoDelete = activeArray.popFront(numDPtoDelete);
            if (numDPtoDelete < 0)
                break;
            activeArray.delete();
            this.vertexArrays.shift();
        }
    }
    popBack() {
        let numDPtoDelete = this.series.data.poped_back;
        if (numDPtoDelete === 0)
            return;
        while (true) {
            const activeArray = this.vertexArrays[this.vertexArrays.length - 1];
            numDPtoDelete = activeArray.popBack(numDPtoDelete);
            if (numDPtoDelete < 0)
                break;
            activeArray.delete();
            this.vertexArrays.pop();
        }
    }
    newArray() {
        return new SeriesSegmentVertexArray(this.gl, this.series.data);
    }
    pushFront() {
        let numDPtoAdd = this.series.data.pushed_front;
        if (numDPtoAdd === 0)
            return;
        let activeArray;
        const newArray = () => {
            activeArray = this.newArray();
            this.vertexArrays.unshift(activeArray);
        };
        if (this.vertexArrays.length === 0) {
            newArray();
            // The very first data point is not drawn
            if (numDPtoAdd < 2)
                return;
            numDPtoAdd--;
        }
        activeArray = this.vertexArrays[0];
        while (true) {
            numDPtoAdd = activeArray.pushFront(numDPtoAdd);
            if (numDPtoAdd <= 0)
                break;
            newArray();
        }
    }
    pushBack() {
        let numDPtoAdd = this.series.data.pushed_back;
        if (numDPtoAdd === 0)
            return;
        let activeArray;
        const newArray = () => {
            activeArray = this.newArray();
            this.vertexArrays.push(activeArray);
        };
        if (this.vertexArrays.length === 0) {
            newArray();
            // The very first data point is not drawn
            if (numDPtoAdd < 2)
                return;
            numDPtoAdd--;
        }
        activeArray = this.vertexArrays[this.vertexArrays.length - 1];
        while (true) {
            numDPtoAdd = activeArray.pushBack(numDPtoAdd);
            if (numDPtoAdd <= 0) {
                break;
            }
            newArray();
        }
    }
    syncBuffer() {
        this.popFront();
        this.popBack();
        this.pushFront();
        this.pushBack();
    }
    draw(renderDomain) {
        const data = this.series.data;
        if (this.vertexArrays.length === 0 || data[0].x > renderDomain.max || data[data.length - 1].x < renderDomain.min)
            return;
        let offset = this.vertexArrays[0].validStart / POINT_PER_DATAPOINT - 1;
        const key = (d) => d.x;
        const minIndex = domainSearch(data, 1, data.length, renderDomain.min, key) + offset;
        const maxIndex = domainSearch(data, minIndex, data.length - 1, renderDomain.max, key) + 1 + offset;
        const minArrayIndex = Math.floor(minIndex / BUFFER_DATA_POINT_CAPACITY);
        const maxArrayIndex = Math.ceil(maxIndex / BUFFER_DATA_POINT_CAPACITY);
        for (let i = minArrayIndex; i < maxArrayIndex; i++) {
            const arrOffset = i * BUFFER_DATA_POINT_CAPACITY;
            offset += this.vertexArrays[i].draw({
                min: minIndex - arrOffset,
                max: maxIndex - arrOffset,
            });
        }
    }
}
class LineChartRenderer {
    constructor(model, gl, options) {
        this.model = model;
        this.gl = gl;
        this.options = options;
        this.program = new LineChartWebGLProgram(this.gl, this.options.debugWebGL);
        this.arrays = new Map();
        this.height = 0;
        this.width = 0;
        this.renderHeight = 0;
        this.renderWidth = 0;
        this.program.use();
        model.updated.on(() => this.drawFrame());
        model.resized.on((w, h) => this.onResize(w, h));
    }
    syncBuffer() {
        for (const s of this.options.series) {
            let a = this.arrays.get(s);
            if (!a) {
                a = new SeriesVertexArray(this.gl, s);
                this.arrays.set(s, a);
            }
            a.syncBuffer();
        }
    }
    syncViewport() {
        this.renderWidth = this.width - this.options.renderPaddingLeft - this.options.renderPaddingRight;
        this.renderHeight = this.height - this.options.renderPaddingTop - this.options.renderPaddingBottom;
        const scale = fromValues(this.renderWidth, this.renderHeight);
        divide(scale, [2., 2.], scale);
        this.gl.uniform2fv(this.program.locations.uProjectionScale, scale);
    }
    onResize(width, height) {
        this.height = height;
        this.width = width;
    }
    drawFrame() {
        var _a, _b;
        this.syncBuffer();
        this.syncDomain();
        const gl = this.gl;
        for (const [ds, arr] of this.arrays) {
            if (!ds.visible) {
                continue;
            }
            const color = resolveColorRGBA((_a = ds.color) !== null && _a !== void 0 ? _a : this.options.color);
            gl.uniform4fv(this.program.locations.uColor, color);
            const lineWidth = (_b = ds.lineWidth) !== null && _b !== void 0 ? _b : this.options.lineWidth;
            gl.uniform1f(this.program.locations.uLineWidth, lineWidth / 2);
            const renderDomain = {
                min: this.model.xScale.invert(this.options.renderPaddingLeft - lineWidth / 2),
                max: this.model.xScale.invert(this.width - this.options.renderPaddingRight + lineWidth / 2),
            };
            arr.draw(renderDomain);
        }
        if (this.options.debugWebGL) {
            const err = gl.getError();
            if (err != gl.NO_ERROR) {
                throw new Error(`WebGL error ${err}`);
            }
        }
    }
    ySvgToView(v) {
        return -v + this.renderHeight / 2 + this.options.renderPaddingTop;
    }
    xSvgToView(v) {
        return v - this.renderWidth / 2 - this.options.renderPaddingLeft;
    }
    syncDomain() {
        this.syncViewport();
        const m = this.model;
        const gl = this.gl;
        const zero = [this.xSvgToView(m.xScale(0)), this.ySvgToView(m.yScale(0))];
        const one = [this.xSvgToView(m.xScale(1)), this.ySvgToView(m.yScale(1))];
        // Not using vec2 for precision
        const scaling = [one[0] - zero[0], one[1] - zero[1]];
        gl.uniform2fv(this.program.locations.uModelScale, scaling);
        gl.uniform2fv(this.program.locations.uModelTranslation, zero);
    }
}
const lineChart = {
    apply(chart) {
        return new LineChartRenderer(chart.model, chart.canvasLayer.gl, chart.options);
    }
};

class NearestPoint {
    constructor(svg, options, model, pModel) {
        this.svg = svg;
        this.options = options;
        this.model = model;
        this.pModel = pModel;
        this.intersectPoints = new Map();
        const initTrans = svg.svgNode.createSVGTransform();
        initTrans.setTranslate(0, 0);
        const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        style.textContent = `
.timechart-crosshair-intersect {
    fill: var(--background-overlay, white);
    visibility: hidden;
}
.timechart-crosshair-intersect circle {
    r: 3px;
}`;
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.classList.add('timechart-crosshair-intersect');
        g.appendChild(style);
        this.container = g;
        this.adjustIntersectPoints();
        svg.svgNode.appendChild(g);
        pModel.updated.on(() => this.adjustIntersectPoints());
    }
    adjustIntersectPoints() {
        var _a, _b;
        const initTrans = this.svg.svgNode.createSVGTransform();
        initTrans.setTranslate(0, 0);
        for (const s of this.options.series) {
            if (!this.intersectPoints.has(s)) {
                const intersect = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                intersect.style.stroke = ((_a = s.color) !== null && _a !== void 0 ? _a : this.options.color).toString();
                intersect.style.strokeWidth = `${(_b = s.lineWidth) !== null && _b !== void 0 ? _b : this.options.lineWidth}px`;
                intersect.transform.baseVal.initialize(initTrans);
                this.container.appendChild(intersect);
                this.intersectPoints.set(s, intersect);
            }
            const intersect = this.intersectPoints.get(s);
            const point = this.pModel.dataPoints.get(s);
            if (!point) {
                intersect.style.visibility = 'hidden';
            }
            else {
                intersect.style.visibility = 'visible';
                const p = this.model.pxPoint(point);
                intersect.transform.baseVal.getItem(0).setTranslate(p.x, p.y);
            }
        }
    }
}
const nearestPoint = {
    apply(chart) {
        return new NearestPoint(chart.svgLayer, chart.options, chart.model, chart.nearestPoint);
    }
};

class Tooltip {
    constructor(el, model, options, nearestPoint) {
        this.el = el;
        this.model = model;
        this.options = options;
        this.nearestPoint = nearestPoint;
        this.items = new Map();
        const mouseOffset = 12;
        this.tooltip = document.createElement('chart-tooltip');
        const ls = this.tooltip.style;
        ls.position = 'absolute';
        ls.visibility = "hidden";
        const legendRoot = this.tooltip.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
:host {
    background: var(--background-overlay, white);
    border: 1px solid hsl(0, 0%, 80%);
    border-radius: 3px;
    padding: 2px 2px;
}
.item {
    user-select: none;
}
td {
    padding: 0px 5px;
}
.name {
    margin-right: 10px;
    max-width: 100px;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
}
.example {
    width: 6px;
    height: 6px;
}
.value {
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
    min-width: 100px;
    max-width: 100px;
    text-align: right;
}
.x-not-aligned .value {
    opacity: 0.4;
}
`;
        legendRoot.appendChild(style);
        const table = document.createElement("table");
        this.xItem = this.createItemElements(this.options.tooltipXLabel);
        table.appendChild(this.xItem.item);
        legendRoot.appendChild(table);
        this.itemContainer = table;
        this.update();
        el.shadowRoot.appendChild(this.tooltip);
        model.updated.on(() => this.update());
        model.disposing.on(() => {
            el.shadowRoot.removeChild(this.tooltip);
        });
        nearestPoint.updated.on(() => {
            if (!options.tooltip || nearestPoint.dataPoints.size == 0) {
                ls.visibility = "hidden";
                return;
            }
            ls.visibility = "visible";
            const p = nearestPoint.lastPointerPos;
            const tooltipRect = this.tooltip.getBoundingClientRect();
            let left = p.x - tooltipRect.width - mouseOffset;
            let top = p.y - tooltipRect.height - mouseOffset;
            if (left < 0)
                left = p.x + mouseOffset;
            if (top < 0)
                top = p.y + mouseOffset;
            ls.left = left + "px";
            ls.top = top + "px";
            // display X for the data point that is the closest to the pointer
            let minPointerDistance = Number.POSITIVE_INFINITY;
            let displayingX = null;
            for (const [s, d] of nearestPoint.dataPoints) {
                const px = model.pxPoint(d);
                const dx = px.x - p.x;
                const dy = px.y - p.y;
                const dis = Math.sqrt(dx * dx + dy * dy);
                if (dis < minPointerDistance) {
                    minPointerDistance = dis;
                    displayingX = d.x;
                }
            }
            this.xItem.value.textContent = displayingX.toLocaleString();
            for (const s of this.options.series) {
                if (!s.visible)
                    continue;
                let point = nearestPoint.dataPoints.get(s);
                let item = this.items.get(s);
                if (item && point) {
                    item.value.textContent = point.y.toLocaleString();
                    item.item.classList.toggle('x-not-aligned', point.x !== displayingX);
                }
            }
        });
    }
    createItemElements(label) {
        const item = document.createElement('tr');
        item.className = 'item';
        const exampleTd = document.createElement('td');
        const example = document.createElement('div');
        example.className = 'example';
        exampleTd.appendChild(example);
        item.appendChild(exampleTd);
        const name = document.createElement('td');
        name.className = "name";
        name.textContent = label;
        item.appendChild(name);
        const value = document.createElement('td');
        value.className = "value";
        item.appendChild(value);
        return { item, example, name, value };
    }
    update() {
        var _a;
        for (const s of this.options.series) {
            if (!this.items.has(s)) {
                const itemElements = this.createItemElements(s.name);
                this.itemContainer.appendChild(itemElements.item);
                this.items.set(s, itemElements);
            }
            const item = this.items.get(s);
            item.example.style.backgroundColor = ((_a = s.color) !== null && _a !== void 0 ? _a : this.options.color).toString();
            item.item.style.display = s.visible ? "" : "none";
        }
    }
}
const tooltip = {
    apply(chart) {
        return new Tooltip(chart.el, chart.model, chart.options, chart.nearestPoint);
    }
};

function addDefaultPlugins(options) {
    var _a;
    const o = options !== null && options !== void 0 ? options : { plugins: undefined, zoom: undefined };
    return Object.assign(Object.assign({}, options), { plugins: Object.assign(Object.assign({}, ((_a = o.plugins) !== null && _a !== void 0 ? _a : {})), { lineChart,
            d3Axis,
            crosshair,
            nearestPoint,
            legend, zoom: new TimeChartZoomPlugin(o.zoom), tooltip }) });
}
class TimeChart extends TimeChart$1 {
    constructor(el, options) {
        super(el, addDefaultPlugins(options));
        this.el = el;
    }
    get options() { return this._options; }
}
// For users who use script tag
TimeChart.core = TimeChart$1;
TimeChart.plugins = {
    lineChart,
    d3Axis,
    crosshair,
    nearestPoint,
    legend,
    TimeChartZoomPlugin,
    tooltip
};

export { TimeChart as default };
//# sourceMappingURL=timechart.module.js.map
