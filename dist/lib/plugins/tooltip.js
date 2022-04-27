export class Tooltip {
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
export const tooltip = {
    apply(chart) {
        return new Tooltip(chart.el, chart.model, chart.options, chart.nearestPoint);
    }
};
//# sourceMappingURL=tooltip.js.map