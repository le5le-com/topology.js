import { commonAnchors, commonPens, cube } from './diagrams';
import { EventType, Handler } from 'mitt';
import { Canvas } from './canvas';
import { Options } from './options';
import {
  calcInView,
  calcTextDrawRect,
  calcTextLines,
  calcTextRect,
  ChartData,
  facePen,
  formatAttrs,
  getAllChildren,
  getFromAnchor,
  getParent,
  getToAnchor,
  getWords,
  LockState,
  Pen,
  PenType,
  renderPenRaw,
  IValue,
} from './pen';
import { Point } from './point';
import {
  clearStore,
  EditAction,
  EditType,
  globalStore,
  register,
  registerAnchors,
  registerCanvasDraw,
  TopologyData,
  TopologyStore,
  useStore,
} from './store';
import { formatPadding, Padding, s8, valueInArray, valueInRange } from './utils';
import { calcCenter, calcEyeRect, calcRelativeRect, getRect, Rect } from './rect';
import { deepClone } from './utils/clone';
import { Event, EventAction, EventName } from './event';
import { Map } from './map';
// TODO: 这种引入方式，引入 connect， webpack 5 报错
import { MqttClient } from 'mqtt';
import * as mqtt from 'mqtt/dist/mqtt.min.js';

import pkg from '../package.json';
import { lockedError } from './utils/error';

export class Topology {
  store: TopologyStore;
  canvas: Canvas;
  websocket: WebSocket;
  mqttClient: MqttClient;
  socketFn: (e: string, topic: string) => void;
  events: Record<number, (pen: Pen, e: Event) => void> = {};
  map: Map;
  mapTimer: NodeJS.Timeout;
  constructor(parent: string | HTMLElement, opts: Options = {}) {
    this.store = useStore(s8());
    this.setOptions(opts);
    this.init(parent);
    this.register(commonPens());
    this.registerCanvasDraw({ cube });
    this.registerAnchors(commonAnchors());
    window && ((window as any).topology = this);
    this.initEventFns();
    this.store.emitter.on('*', this.onEvent);

  }

  facePen = facePen;
  getWords = getWords;
  calcTextLines = calcTextLines;
  calcTextRect = calcTextRect;
  calcTextDrawRect = calcTextDrawRect;

  /**
   * @deprecated 改用 beforeAddPens
   */
  get beforeAddPen() {
    return this.canvas.beforeAddPen;
  }
  /**
   * @deprecated 改用 beforeAddPens
   */
  set beforeAddPen(fn: (pen: Pen) => boolean) {
    this.canvas.beforeAddPen = fn;
  }
  get beforeAddPens() {
    return this.canvas.beforeAddPens;
  }
  set beforeAddPens(fn: (pens: Pen[]) => Promise<boolean>) {
    this.canvas.beforeAddPens = fn;
  }
  get beforeAddAnchor() {
    return this.canvas.beforeAddAnchor;
  }
  set beforeAddAnchor(fn: (pen: Pen, anchor: Point) => Promise<boolean>) {
    this.canvas.beforeAddAnchor = fn;
  }
  get beforeRemovePens() {
    return this.canvas.beforeRemovePens;
  }
  set beforeRemovePens(fn: (pens: Pen[]) => Promise<boolean>) {
    this.canvas.beforeRemovePens = fn;
  }
  get beforeRemoveAnchor() {
    return this.canvas.beforeRemoveAnchor;
  }
  set beforeRemoveAnchor(fn: (pen: Pen, anchor: Point) => Promise<boolean>) {
    this.canvas.beforeRemoveAnchor = fn;
  }

  setOptions(opts: Options = {}) {
    this.store.options = Object.assign(this.store.options, opts);
  }

  getOptions() {
    return this.store.options;
  }

  private init(parent: string | HTMLElement) {
    if (typeof parent === 'string') {
      this.canvas = new Canvas(this, document.getElementById(parent), this.store);
    } else {
      this.canvas = new Canvas(this, parent, this.store);
    }

    this.resize();
    this.canvas.listen();
  }

  initEventFns() {
    this.events[EventAction.Link] = (pen: Pen, e: Event) => {
      if (e.value && typeof e.value === 'string') {
        window.open(e.value, e.params ?? '_blank');
        return;
      }
      console.warn('[topology] Link param is not a string');
    };
    this.events[EventAction.SetProps] = (pen: Pen, e: Event) => {
      // TODO: 若频繁地触发，重复 render 可能带来性能问题，待考虑
      const value = e.value;
      if (value && typeof value === 'object') {
        const pens = e.params ? this.find(e.params) : [pen];
        pens.forEach((pen: Pen) => {
          if (value.hasOwnProperty('visible')) {
            this.setVisible(pen, value.visible);
          }
          this._setValue({ id: pen.id, ...value });
        });
        this.render();
        return;
      }
      console.warn('[topology] SetProps value is not an object');
    };
    this.events[EventAction.StartAnimate] = (pen: Pen, e: Event) => {
      if (!e.value || typeof e.value === 'string') {
        this.startAnimate((e.value as string) || [pen]);
        return;
      }
      console.warn('[topology] StartAnimate value is not a string');
    };
    this.events[EventAction.PauseAnimate] = (pen: Pen, e: Event) => {
      if (!e.value || typeof e.value === 'string') {
        this.pauseAnimate((e.value as string) || [pen]);
        return;
      }
      console.warn('[topology] PauseAnimate value is not a string');
    };
    this.events[EventAction.StopAnimate] = (pen: Pen, e: Event) => {
      if (!e.value || typeof e.value === 'string') {
        this.stopAnimate((e.value as string) || [pen]);
        return;
      }
      console.warn('[topology] StopAnimate event value is not a string');
    };
    this.events[EventAction.Function] = (pen: Pen, e: Event) => {
      if (e.value && !e.fn) {
        try {
          if (typeof e.value !== 'string') {
            throw new Error('[topology] Function value must be string');
          }
          // TODO: 编译 string.replaceAll 报错
          const value: any = e.value;
          const fnJs = value.replaceAll ? value.replaceAll('.setValue(', '._setValue(') : value.replace(/.setValue\(/g, '._setValue(');
          e.fn = new Function('pen', 'params', fnJs) as (pen: Pen, params: string) => void;
        } catch (err) {
          console.error('[topology]: Error on make a function:', err);
        }
      }
      e.fn?.(pen, e.params);
    };
    this.events[EventAction.WindowFn] = (pen: Pen, e: Event) => {
      if (typeof e.value !== 'string') {
        console.warn('[topology] WindowFn value must be a string');
        return;
      }
      if (window && window[e.value]) {
        (window as any)[e.value](pen, e.params);
      }
    };
    this.events[EventAction.Emit] = (pen: Pen, e: Event) => {
      if (typeof e.value !== 'string') {
        console.warn('[topology] Emit value must be a string');
        return;
      }
      this.store.emitter.emit(e.value, {
        pen,
        params: e.params,
      });
    };
  }

  resize(width?: number, height?: number) {
    this.canvas.resize(width, height);
    this.render();
    this.store.emitter.emit('resize', { width, height });

    if (this.canvas.scroll && this.canvas.scroll.isShow) {
      this.canvas.scroll.init();
    }
  }

  async addPen(pen: Pen, history?: boolean) {
    return await this.canvas.addPen(pen, history);
  }

  async addPens(pens: Pen[], history?: boolean) {
    return await this.canvas.addPens(pens, history);
  }

  render(dirty?: boolean | number) {
    this.canvas.render(dirty);
  }

  setBackgroundImage(url: string) {
    this.store.data.bkImage = url;
    this.canvas.canvasImageBottom.canvas.style.backgroundImage = url ? `url(${url})` : '';
    if (url) {
      const img = new Image();
      img.src = url;
      img.onload = () => {
        // 用作 toPng 的绘制
        this.store.bkImg = img;
      };
    } else {
      this.store.bkImg = null;
    }
  }

  setBackgroundColor(color: string = this.store.data.background) {
    this.store.data.background = color;
    this.store.dirtyBackground = true;
  }

  setGrid({
    grid = this.store.data.grid,
    gridColor = this.store.data.gridColor,
    gridSize = this.store.data.gridSize,
    gridRotate = this.store.data.gridRotate,
  }: {
    grid?: boolean;
    gridColor?: string;
    gridSize?: number;
    gridRotate?: number;
  } = {}) {
    this.store.data.grid = grid;
    this.store.data.gridColor = gridColor;
    this.store.data.gridSize = gridSize;
    this.store.data.gridRotate = gridRotate;
    this.store.dirtyBackground = true;
  }

  setRule({
    rule = this.store.data.rule,
    ruleColor = this.store.data.ruleColor,
  }: {
    rule?: boolean;
    ruleColor?: string;
  } = {}) {
    this.store.data.rule = rule;
    this.store.data.ruleColor = ruleColor;
    this.store.dirtyTop = true;
  }

  open(data?: TopologyData) {
    for (const pen of this.store.data.pens) {
      pen.onDestroy?.(pen);
    }

    clearStore(this.store);
    this.hideInput();
    this.canvas.tooltip.hide();
    this.canvas.clearCanvas();

    this.store.dirtyBackground = true;
    this.store.dirtyTop = true;
    this.setBackgroundImage(data?.bkImage);
    if (data) {
      Object.assign(this.store.data, data);
      this.store.data.pens = [];
      // 第一遍赋初值
      for (const pen of data.pens) {
        if (!pen.id) {
          pen.id = s8();
        }
        !pen.calculative && (pen.calculative = { canvas: this.canvas });
        this.store.pens[pen.id] = pen;
      }
      // // 计算区域
      // for (const pen of data.pens) {
      //   this.canvas.dirtyPenRect(pen);
      // }
      for (const pen of data.pens) {
        this.canvas.makePen(pen);
      }
    }

    this.render();
    this.listenSocket();
    this.connectSocket();
    this.startAnimate();
    this.doInitJS();
    this.store.emitter.emit('opened');

    if (this.canvas.scroll && this.canvas.scroll.isShow) {
      this.canvas.scroll.init();
    }
  }

  connectSocket() {
    this.connectWebsocket();
    this.connectMqtt();
    this.connectHttp();
  }

  /**
   * open 后执行初始化 Js ，每个图纸可配置一个初始化 js
   */
  private doInitJS() {
    const initJs = this.store.data.initJs;
    if (initJs && initJs.trim()) {
      try {
        const fn = new Function(initJs) as () => void;
        fn();
      } catch (e) {
        console.warn('initJs error', e);
      }
    }
  }

  drawLine(lineName?: string) {
    lineName && lockedError(this.store);
    this.canvas.drawingLineName = lineName;
  }

  drawingPencil() {
    this.canvas.drawingPencil();
  }

  stopPencil() {
    this.canvas.stopPencil();
  }

  lock(lock: LockState) {
    this.store.data.locked = lock;
    this.finishDrawLine(true);
    this.canvas.drawingLineName = '';
    this.stopPencil();
  }

  // end  - 当前鼠标位置，是否作为终点
  async finishDrawLine(end?: boolean) {
    await this.canvas.finishDrawline(end);
  }

  async finishPencil() {
    await this.canvas.finishPencil();
  }

  updateLineType(pen: Pen, lineName: string) {
    if (!pen || pen.name != 'line' || !lineName || !this.canvas[lineName]) {
      return;
    }

    pen.lineName = lineName;
    const from = getFromAnchor(pen);
    const to = getToAnchor(pen);
    from.prev = undefined;
    from.next = undefined;
    to.prev = undefined;
    to.next = undefined;
    pen.calculative.worldAnchors = [from, to];
    pen.calculative.activeAnchor = from;
    this.canvas[lineName](this.store, pen, to);
    if (pen.lineName === 'curve') {
      from.prev = {
        penId: from.penId,
        x: from.x - 50,
        y: from.y,
      };
      from.next = {
        penId: from.penId,
        x: from.x + 50,
        y: from.y,
      };
      to.prev = {
        penId: to.penId,
        x: to.x - 50,
        y: to.y,
      };
      to.next = {
        penId: to.penId,
        x: to.x + 50,
        y: to.y,
      };
    }
    pen.calculative.activeAnchor = undefined;
    this.canvas.initLineRect(pen);
    this.render();
  }

  addDrawLineFn(fnName: string, fn: Function) {
    this.canvas[fnName] = fn;
    this.canvas.drawLineFns.push(fnName);
  }

  removeDrawLineFn(fnName: string) {
    const index = this.canvas.drawLineFns.indexOf(fnName);
    if (index > -1) {
      this.canvas.drawLineFns.splice(index, 1);
    }
  }

  showMagnifier() {
    this.canvas.showMagnifier();
  }

  hideMagnifier() {
    this.canvas.hideMagnifier();
  }

  toggleMagnifier() {
    this.canvas.toggleMagnifier();
  }

  clear() {
    clearStore(this.store);
    this.canvas.clearCanvas();
    this.render();
  }

  emit(eventType: EventType, data: unknown) {
    this.store.emitter.emit(eventType, data);
  }

  on(eventType: EventType, handler: Handler) {
    this.store.emitter.on(eventType, handler);
    return this;
  }

  off(eventType: EventType, handler: Handler) {
    this.store.emitter.off(eventType, handler);
    return this;
  }

  register = register;

  registerCanvasDraw = registerCanvasDraw;

  registerAnchors = registerAnchors;

  // customeDock = (store, rect, pens, offset) => {xDock, yDock}
  // customDock return:
  // {
  //   xDock: {x, y, step, prev, penId},
  //   yDock: {x, y, step, prev, penId},
  // }
  // xDock，yDock - 水平或垂直方向的参考线
  // prev - 参考线的起点
  // x,y - 参考线的终点
  // step - 自动吸附需要的偏移量
  // penId - 参考线的笔
  registerMoveDock(
    dock: (store: TopologyStore, rect: Rect, pens: Pen[], offset: Point) => { xDock: Point; yDock: Point }
  ) {
    this.canvas.customeMoveDock = dock;
  }

  /**
   * 参数同方法 registerMoveDock ，最后一个参数由 offset 偏移修改成了当前 resize 的点
   */
  registerResizeDock(
    dock: (store: TopologyStore, rect: Rect, pens: Pen[], resizeIndex: number) => { xDock: Point; yDock: Point }
  ) {
    this.canvas.customeResizeDock = dock;
  }

  find(id: string): Pen[];
  find(tag: string): Pen[];
  find(idOrTag: string): Pen[] {
    return this.canvas.find(idOrTag);
  }

  /**
   * 使用 Array.find 找到即返回，否则返回 undefined
   */
  findOne(id: string): Pen | undefined;
  findOne(tag: string): Pen | undefined;
  findOne(idOrTag: string): Pen | undefined {
    return this.canvas.findOne(idOrTag);
  }

  getPenRect(pen: Pen) {
    return this.canvas.getPenRect(pen);
  }

  setPenRect(pen: Pen, rect: Rect, render = true) {
    this.canvas.setPenRect(pen, rect, render);
  }

  startAnimate(idOrTagOrPens?: string | Pen[]): void {
    let pens: Pen[];
    if (!idOrTagOrPens) {
      pens = this.store.data.pens.filter((pen) => {
        return (pen.type || pen.frames) && pen.autoPlay;
      });
    } else if (typeof idOrTagOrPens === 'string') {
      pens = this.find(idOrTagOrPens);
    } else {
      pens = idOrTagOrPens;
    }
    pens.forEach((pen) => {
      if (pen.calculative.pause) {
        const d = Date.now() - pen.calculative.pause;
        pen.calculative.pause = undefined;
        pen.calculative.frameStart += d;
        pen.calculative.frameEnd += d;
      } else {
        this.store.animates.add(pen);
      }
    });
    this.canvas.canvasImage.initStatus();
    this.canvas.canvasImageBottom.initStatus();
    this.canvas.animate();
  }

  pauseAnimate(idOrTagOrPens?: string | Pen[]) {
    let pens: Pen[] = [];
    if (!idOrTagOrPens) {
      this.store.animates.forEach((pen) => {
        pens.push(pen);
      });
    } else if (typeof idOrTagOrPens === 'string') {
      pens = this.find(idOrTagOrPens);
    } else {
      pens = idOrTagOrPens;
    }
    pens.forEach((pen) => {
      if (!pen.calculative.pause) {
        pen.calculative.pause = Date.now();
      }
    });
  }

  stopAnimate(idOrTagOrPens?: string | Pen[]) {
    let pens: Pen[] = [];
    if (!idOrTagOrPens) {
      this.store.animates.forEach((pen) => {
        pens.push(pen);
      });
    } else if (typeof idOrTagOrPens === 'string') {
      pens = this.find(idOrTagOrPens);
    } else {
      pens = idOrTagOrPens;
    }
    pens.forEach((pen) => {
      pen.calculative.pause = undefined;
      pen.calculative.start = undefined;
      pen.calculative.duration = undefined;
      pen.calculative.animatePos = 0;
      this.store.animates.delete(pen);
      this.canvas.restoreNodeAnimate(pen);
    });
    this.needInitStatus(pens);
    setTimeout(() => {
      this.canvas.calcActiveRect();
      this.render();
    }, 20);
  }

  calcAnimateDuration(pen: Pen) {
    return pen.frames.reduce((prev, frame) => prev + frame.duration, 0);
  }

  /**
   * 组合
   * @param pens 组合的画笔们
   * @param showChild 组合后展示第几个孩子
   */
  combine(pens: Pen[] = this.store.active, showChild?: number) {
    if (!pens || !pens.length) {
      return;
    }

    const initPens = deepClone(pens);
    if (pens.length === 1 && pens[0].type) {
      pens[0].type = PenType.Node;
      this.canvas.active(pens);
      this.pushHistory({
        type: EditType.Update,
        initPens,
        pens: deepClone(pens, true),
      });
      this.render();
      return;
    }

    const rect = getRect(pens);
    let parent: Pen = {
      id: s8(),
      name: 'combine',
      ...rect,
      children: [],
      showChild,
    };
    const p = pens.find((pen) => {
      return pen.width === rect.width && pen.height === rect.height;
    });
    // 其中一个认为是父节点
    const oneIsParent = p && showChild == undefined;
    if (oneIsParent) {
      if (!p.children) {
        p.children = [];
      }
      parent = p;
    } else {
      // 若组合为状态，那么 parent 一定是 combine
      this.canvas.makePen(parent);
    }

    pens.forEach((pen) => {
      if (pen === parent || pen.parentId === parent.id) {
        return;
      }
      // pen 来自于 store.active ，不存在有 parentId 的情况
      parent.children.push(pen.id);
      pen.parentId = parent.id;
      const childRect = calcRelativeRect(pen.calculative.worldRect, rect);
      Object.assign(pen, childRect);
      pen.locked = LockState.DisableMove;
    });
    this.canvas.active([parent]);
    let step = 1;
    if (!oneIsParent) {
      step = 2;
      this.pushHistory({
        type: EditType.Add,
        pens: [parent],
        step,
      });
      this.store.emitter.emit('add', [parent]);
    }
    this.pushHistory({
      type: EditType.Update,
      initPens,
      pens,
      step,
    });
    if (showChild != undefined) {
      pens.forEach((pen) => {
        calcInView(pen, true);
      });
      this.needInitStatus([parent]);
    }
    this.render();
  }

  uncombine(pen?: Pen) {
    if (!pen && this.store.active) {
      pen = this.store.active[0];
    }
    if (!pen || !pen.children) {
      return;
    }

    const children = pen.children.map((childId) => this.store.pens[childId]);
    let initPens = deepClone(children);
    children.forEach((child) => {
      child.parentId = undefined;
      child.x = child.calculative.worldRect.x;
      child.y = child.calculative.worldRect.y;
      child.width = child.calculative.worldRect.width;
      child.height = child.calculative.worldRect.height;
      child.locked = LockState.None;
      child.calculative.active = undefined;
      child.calculative.hover = false;
      this.setVisible(child, true); // 子节点的 visible 属性已经改变，需要恢复
    });
    const step = pen.name === 'combine' ? 3 : 2;
    this.pushHistory({
      type: EditType.Update,
      initPens,
      pens: children,
      step,
    });
    initPens = [deepClone(pen)];
    pen.children = undefined;
    // 保存修改 children 的历史记录
    this.pushHistory({
      type: EditType.Update,
      initPens,
      pens: [pen],
      step,
    });
    if (pen.name === 'combine') {
      this.delete([pen]);
      // delete 会记录 history , 更改 step 即可
      this.store.histories[this.store.histories.length - 1].step = step;
    }
    this.inactive();
  }

  active(pens: Pen[], emit = true) {
    this.canvas.active(pens, emit);
  }

  inactive() {
    this.canvas.inactive();
  }

  /**
   * 删除画笔
   * @param pens 需要删除的画笔们
   * @param delLock 是否删除已经锁住的画笔
   */
  delete(pens?: Pen[], delLock = false) {
    this.canvas.delete(pens, undefined, delLock);
  }

  scale(scale: number, center = { x: 0, y: 0 }) {
    this.canvas.scale(scale, center);
  }

  translate(x: number, y: number) {
    this.canvas.translate(x, y);
  }

  translatePens(pens: Pen[], x: number, y: number) {
    this.canvas.translatePens(pens, x, y);
  }

  getParent(pen: Pen, root?: boolean) {
    return getParent(pen, root);
  }

  data(): TopologyData {
    const data: TopologyData = deepClone(this.store.data);
    const { pens, paths } = this.store.data;
    data.version = pkg.version;
    // TODO: 未在 delete 时清除，避免撤销等操作。
    // 清除一些未使用到的 paths
    data.paths = {};
    for (const pathId in paths) {
      if (Object.prototype.hasOwnProperty.call(paths, pathId)) {
        if (pens.find((pen) => pen.pathId === pathId)) {
          data.paths[pathId] = paths[pathId];
        }
      }
    }
    return data;
  }

  copy(pens?: Pen[]) {
    this.canvas.copy(pens);
  }

  cut(pens?: Pen[]) {
    this.canvas.cut(pens);
  }

  paste() {
    this.canvas.paste();
  }

  undo() {
    this.canvas.undo();
  }

  redo() {
    this.canvas.redo();
  }

  listenSocket() {
    try {
      let socketFn: (e: string, topic: string) => void;
      const socketCbJs = this.store.data.socketCbJs;
      if (socketCbJs) {
        socketFn = new Function('e', 'topic', socketCbJs) as (e: string, topic: string) => void;
      }
      if (!socketFn) {
        return false;
      }
      this.socketFn = socketFn;
    } catch (e) {
      console.error('Create the function for socket:', e);
      return false;
    }

    return true;
  }

  connectWebsocket(websocket?: string) {
    this.closeWebsocket();
    if (websocket) {
      this.store.data.websocket = websocket;
    }
    if (this.store.data.websocket) {
      this.websocket = new WebSocket(this.store.data.websocket);
      this.websocket.onmessage = (e) => {
        // TODO: 目前只支持 string 类型的数据
        // ws 本身还支持 Blob 和 ArrayBuffer 的
        this.doSocket(e.data);
      };

      this.websocket.onclose = () => {
        console.info('Canvas websocket closed and reconneting...');
        this.connectWebsocket();
      };
    }
  }

  closeWebsocket() {
    if (this.websocket) {
      this.websocket.onclose = undefined;
      this.websocket.close();
      this.websocket = undefined;
    }
  }

  connectMqtt(params?: {
    mqtt: string;
    mqttTopics: string;
    mqttOptions?: {
      clientId?: string;
      username?: string;
      password?: string;
      customClientId?: boolean;
    };
  }) {
    this.closeMqtt();
    if (params) {
      this.store.data.mqtt = params.mqtt;
      this.store.data.mqttTopics = params.mqttTopics;
      this.store.data.mqttOptions = params.mqttOptions;
    }
    if (this.store.data.mqtt) {
      if (this.store.data.mqttOptions.clientId && !this.store.data.mqttOptions.customClientId) {
        this.store.data.mqttOptions.clientId = s8();
      }

      this.mqttClient = mqtt.connect(this.store.data.mqtt, this.store.data.mqttOptions);
      this.mqttClient.on('message', (topic: string, message: Buffer) => {
        this.doSocket(message.toString(), topic);
      });

      if (this.store.data.mqttTopics) {
        this.mqttClient.subscribe(this.store.data.mqttTopics.split(','));
      }
    }
  }

  closeMqtt() {
    this.mqttClient?.end();
  }

  httpTimer: NodeJS.Timeout;
  connectHttp() {
    this.closeHttp();
    const { http, httpTimeInterval } = this.store.data;
    if (http) {
      this.httpTimer = setInterval(async () => {
        // 默认每一秒请求一次
        const res: Response = await fetch(http);
        if (res.ok) {
          const data = await res.text();
          this.doSocket(data);
        }
      }, httpTimeInterval || 1000);
    }
  }

  closeHttp() {
    clearInterval(this.httpTimer);
    this.httpTimer = undefined;
  }

  doSocket(message: string, topic = '') {
    if (this.socketFn) {
      this.socketFn(message, topic);
      return;
    }

    try {
      const messageObj = JSON.parse(message);
      const values: IValue[] = !Array.isArray(messageObj) ? [messageObj] : messageObj;
      const formPens = this.store.data.pens.filter((pen) => pen.form);
      const dataIdValues = values.filter((value) => value.dataId);
      dataIdValues.length && this.setValuesByDataId(formPens, dataIdValues);
      values.forEach((value) => {
        if (!value.dataId) {
          this.setValue(value, { render: false });
        }
      });
      this.render();
    } catch (error) {
      console.warn('Invalid socket data:', error);
    }
  }

  /**
   * bind 变量，根据 dataId 变量值 setValue
   * @param pens 要更新的 pens ，此处即 formPens
   * @param dataIdValues 包含 dataId 的 values
   */
  private setValuesByDataId(pens: Pen[] = [], dataIdValues: IValue[]) {
    const values: IValue[] = [];
    pens.forEach((pen) => {
      pen.form?.forEach((formItem) => {
        const dataIds = formItem.dataIds;
        if (!dataIds) {
          return;
        }
        if (Array.isArray(dataIds)) {
          // TODO: 单属性 绑定多变量 dataId
          if (typeof pen.onBinds === 'function') {
            values.push(...pen.onBinds(pen, dataIdValues, formItem));
          } else {
            console.warn('Not support onBinds for pen:', pen);
          }
        } else {
          const dataIdValue = dataIdValues.find((value) => value.dataId === dataIds.dataId);
          if (dataIdValue) {
            values.push({
              id: pen.id,
              [formItem.key]: dataIdValue.value,
            } as IValue);
          }
        }
      });
    });
    values.forEach((value) => {
      this.setValue(value, { render: false });
    });
  }

  setValue(data: IValue, { render = true }: { render?: boolean } = {}) {
    const { pens, rects, oldActiveRect } = this._setValue(data);
    pens.forEach(pen => {
      this.store.emitter.emit('valueUpdate', pen);
    });

    render && this.canvas.renderDirty(rects, oldActiveRect);
  }

  _setValue(data: IValue) {
    let pens: Pen[] = [];
    if (data.id) {
      /**
       * 传入 id 使用 store.pens 查找
       * TODO: 代码或许可以优化成一行
       */
      const pen = this.store.pens[data.id];
      pen && pens.push(pen);
    } else {
      pens = this.find(data.tag);
    }
    const rects: Rect[] = [];
    pens.forEach((pen) => {
      rects.push(calcEyeRect(pen.calculative.worldRect, pen.calculative.lineWidth));
      const afterData: IValue = pen.onBeforeValue ? pen.onBeforeValue(pen, data as ChartData) : data;
      this.canvas.updateValue(pen, afterData);
      pen.onValue?.(pen);
      rects.push(calcEyeRect(pen.calculative.worldRect, pen.calculative.lineWidth));
    });

    let oldActiveRect: Rect = undefined;
    if (!this.store.data.locked && this.store.active.length && !this.canvas.movingPens) {
      // 移动过程中，不重算 activeRect
      oldActiveRect = deepClone(this.canvas.activeRect);
      this.canvas.calcActiveRect();
    }

    return {
      pens,
      rects,
      oldActiveRect
    };
  }

  pushHistory(action: EditAction) {
    this.canvas.pushHistory(action);
  }

  showInput(pen: Pen, rect?: Rect) {
    this.canvas.showInput(pen, rect);
  }

  hideInput() {
    this.canvas.hideInput();
  }

  clearDropdownList() {
    this.canvas.clearDropdownList();
  }

  private onEvent = (eventName: string, e: any) => {
    switch (eventName) {
      case 'add':
        {
          e.forEach((pen: Pen) => {
            pen.onAdd?.(pen);
          });
        }
        this.onSizeUpdate();
        break;
      case 'enter':
        e && e.onMouseEnter && e.onMouseEnter(e, this.canvas.mousePos);
        this.store.data.locked && this.doEvent(e, eventName);
        break;
      case 'leave':
        e && e.onMouseLeave && e.onMouseLeave(e, this.canvas.mousePos);
        this.store.data.locked && this.doEvent(e, eventName);
        break;
      case 'active':
      case 'inactive':
        {
          this.store.data.locked &&
            e.forEach((pen: Pen) => {
              this.doEvent(pen, eventName);
            });
        }
        break;
      case 'click':
        e.pen && e.pen.onClick && e.pen.onClick(e.pen, this.canvas.mousePos);
        this.store.data.locked && e.pen && this.doEvent(e.pen, eventName);
        break;
      case 'mousedown':
        e.pen && e.pen.onMouseDown && e.pen.onMouseDown(e.pen, this.canvas.mousePos);
        this.store.data.locked && e.pen && this.doEvent(e.pen, eventName);
        break;
      case 'mouseup':
        e.pen && e.pen.onMouseUp && e.pen.onMouseUp(e.pen, this.canvas.mousePos);
        this.store.data.locked && e.pen && this.doEvent(e.pen, eventName);
        break;
      case 'dblclick':
        this.store.data.locked && e.pen && this.doEvent(e.pen, eventName);
        break;
      case 'valueUpdate':
        // TODO: setValue 触发 valueUpdate 消息，导致执行两次 onValue 事件
        e.onValue?.(e);
        this.store.data.locked && this.doEvent(e, eventName);
        this.canvas.tooltip.updateText(e as Pen);
        break;
      case 'update':
      case 'delete':
      case 'translatePens':
      case 'rotatePens':
      case 'resizePens':
        this.onSizeUpdate();
        break;
    }
  };

  private doEvent = (pen: Pen, eventName: EventName) => {
    if (!pen) {
      return;
    }

    pen.events?.forEach((event) => {
      if (this.events[event.action] && event.name === eventName) {
        let can = !event.where;
        if (event.where) {
          const { fn, fnJs, comparison, key, value } = event.where;
          if (fn) {
            can = fn(pen);
          } else if (fnJs) {
            try {
              event.where.fn = new Function('pen', fnJs) as (pen: Pen) => boolean;
            } catch (err) {
              console.error('Error: make function:', err);
            }
            if (event.where.fn) {
              can = event.where.fn(pen);
            }
          } else {
            switch (comparison) {
              case '>':
                can = pen[key] > +value;
                break;
              case '>=':
                can = pen[key] >= +value;
                break;
              case '<':
                can = pen[key] < +value;
                break;
              case '<=':
                can = pen[key] <= +value;
                break;
              case '=':
              case '==':
                can = pen[key] == value;
                break;
              case '!=':
                can = pen[key] != value;
                break;
              case '[)':
                can = valueInRange(+pen[key], value);
                break;
              case '![)':
                can = !valueInRange(+pen[key], value);
                break;
              case '[]':
                can = valueInArray(+pen[key], value);
                break;
              case '![]':
                can = !valueInArray(+pen[key], value);
                break;
            }
          }
        }
        can && this.events[event.action](pen, event);
      }
    });
    // 事件冒泡，子执行完，父执行
    this.doEvent(this.store.pens[pen.parentId], eventName);
  };

  pushChildren(parent: Pen, children: Pen[]) {
    const initUpdatePens: Pen[] = [deepClone(parent, true)];
    const addPens: Pen[] = [];
    if (!parent.children) {
      parent.children = [];
    }
    const updatePens: Pen[] = [];
    children.forEach((pen) => {
      let oldPen: Pen = deepClone(pen, true);
      if (!pen.id || !this.store.pens[pen.id]) {
        // 不存在于 store 中
        this.canvas.makePen(pen);
        oldPen = null; // 添加操作
      }
      if (pen.parentId) {
        const oldParent = this.store.pens[pen.parentId];
        const i = oldParent.children.findIndex((id) => id === pen.id);
        initUpdatePens.push(deepClone(oldParent, true));
        oldParent.children.splice(i, 1);
        updatePens.push(deepClone(oldParent, true));
      }
      parent.children.push(pen.id);
      pen.parentId = parent.id;
      const childRect = calcRelativeRect(pen.calculative.worldRect, parent.calculative.worldRect);
      Object.assign(pen, childRect);
      pen.locked = LockState.DisableMove;
      if (!oldPen) {
        addPens.push(deepClone(pen, true));
      } else {
        initUpdatePens.push(oldPen);
        updatePens.push(deepClone(pen, true));
      }
    });
    updatePens.push(deepClone(parent, true));
    let step = 1;
    if (addPens.length) {
      step = 2;
      this.pushHistory({
        type: EditType.Add,
        pens: addPens,
        step,
      });
    }
    this.pushHistory({
      type: EditType.Update,
      initPens: initUpdatePens,
      pens: updatePens,
      step,
    });
  }

  renderPenRaw = renderPenRaw;

  toPng(padding?: Padding, callback?: BlobCallback, containBkImg = false) {
    return this.canvas.toPng(padding, callback, containBkImg);
  }

  /**
   * 下载 png
   * @param name 传入参数自带文件后缀名 例如：'test.png'
   * @param padding 上右下左的内边距
   */
  downloadPng(name?: string, padding?: Padding) {
    const a = document.createElement('a');
    a.setAttribute('download', name || 'le5le.topology.png');
    a.setAttribute('href', this.toPng(padding, undefined, true));
    const evt = document.createEvent('MouseEvents');
    evt.initEvent('click', true, true);
    a.dispatchEvent(evt);
  }

  getRect(pens: Pen[] = this.store.data.pens) {
    return getRect(pens);
  }

  /**
   * 放大到屏幕尺寸，并居中
   * @param fit true，填满但完整展示；false，填满，但长边可能截取（即显示不完整）
   */
  fitView(fit: boolean = true, viewPadding: Padding = 10) {
    // 默认垂直填充，两边留白
    if (!this.hasView()) return;
    // 1. 重置画布尺寸为容器尺寸
    const { canvas } = this.canvas;
    const { offsetWidth: width, offsetHeight: height } = canvas;
    this.resize(width, height);
    // 2. 获取设置的留白值
    const padding = formatPadding(viewPadding);

    // 3. 获取图形尺寸
    const rect = this.getRect();

    // 4. 计算缩放比例
    const w = (width - padding[1] - padding[3]) / rect.width;
    const h = (height - padding[0] - padding[2]) / rect.height;
    let ratio = w;
    if (fit) {
      // 完整显示取小的
      ratio = w > h ? h : w;
    } else {
      ratio = w > h ? w : h;
    }
    // 该方法直接更改画布的 scale 属性，所以比率应该乘以当前 scale
    this.scale(ratio * this.store.data.scale);

    // 5. 居中
    this.centerView();
  }

  centerView() {
    if (!this.hasView()) return;
    const rect = this.getRect();
    const viewCenter = this.getViewCenter();
    const pensRect: Rect = this.getPenRect(rect);
    calcCenter(pensRect);
    const { center } = pensRect;
    const { scale, origin, x: dataX, y: dataY } = this.store.data;
    // center 的值，在缩放和拖拽画布过程中不发生变化，是相对值
    // viewCenter 是一个绝对值，需要根据 origin 的值，来计算出相对的值
    // store.data.x 是画布偏移值，在 translate 方法中与 scale 相关，这里也需要计算
    this.translate(
      (viewCenter.x - origin.x) / scale - center.x - dataX / scale,
      (viewCenter.y - origin.y) / scale - center.y - dataY / scale
    );
    const { canvas } = this.canvas;
    const x = (canvas.scrollWidth - canvas.offsetWidth) / 2;
    const y = (canvas.scrollHeight - canvas.offsetHeight) / 2;
    canvas.scrollTo(x, y);
  }

  /**
   * 画布是否有 画笔
   * RuleLine 不算
   */
  hasView(): boolean {
    return !!this.store.data.pens.filter((pen) => !pen.isRuleLine).length;
  }

  private getViewCenter() {
    const { width, height } = this.canvas;
    return {
      x: width / 2,
      y: height / 2,
    };
  }

  /**
   * 其它图形的部分变成第一个的
   * @param pens 画笔们
   */
  beSameByFirst(pens: Pen[] = this.store.data.pens) {
    const initPens = deepClone(pens); // 原 pens ，深拷贝一下

    // 1. 得到第一个画笔的 宽高 字体大小
    const firstPen = pens[0];
    const { width, height } = this.getPenRect(firstPen);
    // 格式刷修改的属性，除开宽高
    const attrs = {};
    formatAttrs.forEach((attr) => {
      attrs[attr] = firstPen[attr];
    });

    // 2. 修改其它画笔的 宽高 fontSize
    for (let i = 1; i < pens.length; i++) {
      const pen = pens[i];
      this._setValue({ id: pen.id, width, height, ...attrs });
    }
    this.render();

    this.pushHistory({
      type: EditType.Update,
      initPens,
      pens,
    });
  }

  alignNodes(align: string, pens: Pen[] = this.store.data.pens, rect?: Rect) {
    !rect && (rect = this.getPenRect(this.getRect(pens)));
    const initPens = deepClone(pens); // 原 pens ，深拷贝一下
    for (const item of pens) {
      this.alignPen(align, item, rect);
    }
    this.render();
    this.pushHistory({
      type: EditType.Update,
      initPens,
      pens,
    });
  }

  /**
   * 对齐画笔，基于第一个画笔
   * @param align 左对齐，右对齐，上对齐，下对齐，居中对齐
   * @param pens
   */
  alignNodesByFirst(align: string, pens: Pen[] = this.store.data.pens) {
    const initPens = deepClone(pens); // 原 pens ，深拷贝一下
    const firstPen = pens[0];
    const rect = this.getPenRect(firstPen);
    for (let i = 1; i < pens.length; i++) {
      const pen = pens[i];
      this.alignPen(align, pen, rect);
    }
    this.render();
    this.pushHistory({
      type: EditType.Update,
      initPens,
      pens,
    });
  }

  /**
   * 将画笔参照 rect 进行 align 对齐
   * @param align 左对齐，右对齐，上对齐，下对齐，居中对齐
   * @param pen 当前需要对齐的画笔
   * @param rect 参照矩形
   * @returns
   */
  private alignPen(align: string, pen: Pen, rect: Rect) {
    const penRect = this.getPenRect(pen);
    switch (align) {
      case 'left':
        penRect.x = rect.x;
        break;
      case 'right':
        penRect.x = rect.x + rect.width - penRect.width;
        break;
      case 'top':
        penRect.y = rect.y;
        break;
      case 'bottom':
        penRect.y = rect.y + rect.height - penRect.height;
        break;
      case 'center':
        penRect.x = rect.x + rect.width / 2 - penRect.width / 2;
        break;
      case 'middle':
        penRect.y = rect.y + rect.height / 2 - penRect.height / 2;
        break;
    }
    this._setValue({ id: pen.id, ...penRect });
  }

  /**
   * 水平或垂直方向的均分
   * @param direction 方向，width 说明水平方向间距相同
   * @param pens 节点们，默认全部的
   * @param distance 总的宽 or 高
   */
  private spaceBetweenByDirection(
    direction: 'width' | 'height',
    pens: Pen[] = this.store.data.pens,
    distance?: number
  ) {
    !distance && (distance = this.getPenRect(this.getRect(pens))[direction]);
    // 过滤出非父节点
    pens = pens.filter((item) => !item.parentId);
    if (pens.length <= 2) {
      return;
    }
    const initPens = deepClone(pens); // 原 pens ，深拷贝一下
    // 计算间距
    const allDistance = pens.reduce((distance: number, currentPen: Pen) => {
      const currentPenRect = this.getPenRect(currentPen);
      return distance + currentPenRect[direction];
    }, 0);
    const space = (distance - allDistance) / (pens.length - 1);

    // 按照大小顺序排列画笔
    pens = pens.sort((a: Pen, b: Pen) => {
      if (direction === 'width') {
        return a.x - b.x;
      }
      return a.y - b.y;
    });

    const pen0Rect = this.getPenRect(pens[0]);
    let left = direction === 'width' ? pen0Rect.x : pen0Rect.y;
    for (const pen of pens) {
      const penRect = this.getPenRect(pen);
      direction === 'width' ? (penRect.x = left) : (penRect.y = left);
      left += penRect[direction] + space;
      this._setValue({ id: pen.id, ...penRect });
    }
    this.render();
    this.pushHistory({
      type: EditType.Update,
      initPens,
      pens,
    });
  }

  spaceBetween(pens?: Pen[], width?: number) {
    this.spaceBetweenByDirection('width', pens, width);
  }

  spaceBetweenColumn(pens?: Pen[], height?: number) {
    this.spaceBetweenByDirection('height', pens, height);
  }

  layout(pens: Pen[] = this.store.data.pens, width?: number, space: number = 30) {
    const rect = this.getPenRect(getRect(pens));
    !width && (width = rect.width);

    // 1. 拿到全部节点中最大的高
    pens = pens.filter((item) => !item.type && !item.parentId);
    const initPens = deepClone(pens); // 原 pens ，深拷贝一下
    let maxHeight = 0;

    pens.forEach((pen: Pen) => {
      const penRect = this.getPenRect(pen);
      penRect.height > maxHeight && (maxHeight = penRect.height);
    });

    // 2. 遍历节点调整位置
    let currentX = rect.x;
    let currentY = rect.y;
    pens.forEach((pen: Pen, index: number) => {
      const penRect = this.getPenRect(pen);
      penRect.x = currentX;
      penRect.y = currentY + maxHeight / 2 - penRect.height / 2;

      this._setValue({ id: pen.id, ...penRect });

      if (index === pens.length - 1) {
        return;
      }
      const currentWidth = currentX + penRect.width - rect.x;
      const nextPenRect = this.getPenRect(pens[index + 1]);
      if (Math.round(width - currentWidth) >= Math.round(nextPenRect.width + space))
        // 当前行
        currentX += penRect.width + space;
      else {
        // 换行
        currentX = rect.x;
        currentY += maxHeight + space;
      }
    });
    this.render();
    this.pushHistory({
      type: EditType.Update,
      initPens,
      pens,
    });
  }

  gotoView(pen: Pen) {
    const center = this.getViewCenter();
    const x = center.x - pen.calculative.worldRect.x - pen.calculative.worldRect.width / 2;
    const y = center.y - pen.calculative.worldRect.y - pen.calculative.worldRect.height / 2;

    if (this.canvas.scroll && this.canvas.scroll.isShow) {
      this.canvas.scroll.translate(x - this.store.data.x, y - this.store.data.y);
    }

    this.store.data.x = x;
    this.store.data.y = y;

    this.canvas.canvasImage.initStatus();
    this.canvas.canvasImageBottom.initStatus();
    this.render();
  }

  showMap() {
    if (!this.map) {
      this.map = new Map(this.canvas);
    }
    this.map.show();
  }

  hideMap() {
    this.map.hide();
  }

  onSizeUpdate() {
    if (this.mapTimer) {
      clearTimeout(this.mapTimer);
      this.mapTimer = undefined;
    }

    this.mapTimer = setTimeout(() => {
      if (this.map && this.map.isShow) {
        this.map.show();
      }
      if (this.canvas.scroll && this.canvas.scroll.isShow) {
        this.canvas.scroll.resize();
      }
    }, 500);
  }

  toggleAnchorMode() {
    this.canvas.toggleAnchorMode();
  }

  addAnchorHand() {
    this.canvas.addAnchorHand();
  }

  removeAnchorHand() {
    this.canvas.removeAnchorHand();
  }

  toggleAnchorHand() {
    this.canvas.toggleAnchorHand();
  }

  /**
   * 将该画笔置顶，即放到数组最后，最后绘制即在顶部
   * @param pen pen 置顶的画笔
   * @param pens 画笔们
   */
  top(pen: Pen, pens: Pen[] = this.store.data.pens) {
    // 获取它包含它的子节点
    const allIds = [...getAllChildren(pen, this.store), pen].map((p) => p.id);
    const allPens = pens.filter((p) => allIds.includes(p.id));
    allPens.forEach((pen) => {
      const index = pens.findIndex((p: Pen) => p.id === pen.id);
      if (index > -1) {
        pens.push(pens[index]);
        pens.splice(index, 1);
        this.needInitStatus([pen]);
      }
    });
  }

  /**
   * 若本次改变的画笔存在图片，并且在上层 or 下层，需要擦除上层 or 下层
   * 子节点中包含图片，也需要重绘
   * @param pens 本次改变的 pens
   */
  needInitStatus(pens: Pen[]) {
    this.canvas.needInitStatus(pens);
  }

  /**
   * 该画笔置底，即放到数组最前，最后绘制即在底部
   */
  bottom(pen: Pen, pens: Pen[] = this.store.data.pens) {
    const allIds = [...getAllChildren(pen, this.store), pen].map((p) => p.id);
    const allPens = pens.filter((p) => allIds.includes(p.id));
    // 从后往前，保证 allPens 顺序不变
    for (let i = allPens.length - 1; i >= 0; i--) {
      const pen = allPens[i];
      const index = pens.findIndex((p: Pen) => p.id === pen.id);
      if (index > -1) {
        pens.unshift(pens[index]);
        pens.splice(index + 1, 1);
        this.needInitStatus([pen]);
      }
    }
  }

  up(pen: Pen, pens: Pen[] = this.store.data.pens) {
    const index = pens.findIndex((p: Pen) => p.id === pen.id);

    if (index > -1 && index !== pens.length - 1) {
      pens.splice(index + 2, 0, pens[index]);
      pens.splice(index, 1);
      this.needInitStatus([pen]);
    }
  }

  down(pen: Pen, pens: Pen[] = this.store.data.pens) {
    const index = pens.findIndex((p: Pen) => p.id === pen.id);
    if (index > -1 && index !== 0) {
      pens.splice(index - 1, 0, pens[index]);
      pens.splice(index + 1, 1);
      this.needInitStatus([pen]);
    }
  }

  setLayer(pen: Pen, toIndex: number, pens?: Pen[]) {
    if (!pens) {
      pens = this.store.data.pens;
    }
    const index = pens.findIndex((p: Pen) => p.id === pen.id);
    if (index > -1) {
      if (index > toIndex) {
        // 原位置在后，新位置在前
        pens.splice(toIndex, 0, pens[index]);
        pens.splice(index + 1, 1);
      } else if (index < toIndex) {
        // 新位置在后
        pens.splice(toIndex, 0, pens[index]);
        pens.splice(index, 1);
      }
    }
  }

  changePenId(oldId: string, newId: string): void {
    this.canvas.changePenId(oldId, newId);
  }

  /**
   * 得到与当前节点连接的线
   * @param node 节点，非连线
   * @param type 类型，全部的连接线/入线/出线
   */
  getLines(node: Pen, type: 'all' | 'in' | 'out' = 'all'): Pen[] {
    if (node.type === PenType.Line) {
      return [];
    }
    const lines: Pen[] = [];
    node.connectedLines?.forEach(({ lineId }) => {
      const line = this.store.pens[lineId];
      if (!line) {
        console.warn(node, 'node contain a error connectedLine');
        return;
      }
      switch (type) {
        case 'all':
          lines.push(line);
          break;
        case 'in':
          // 进入该节点的线，即 线锚点的最后一个 connectTo 对应该节点
          getToAnchor(line).connectTo === node.id && lines.push(line);
          break;
        case 'out':
          // 从该节点出去的线，即 线锚点的第一个 connectTo 对应该节点
          getFromAnchor(line).connectTo === node.id && lines.push(line);
          break;
      }
    });

    return lines;
  }

  /**
   * 得到当前节点的下一个节点，即出口节点数组
   * 得到当前连线的出口节点
   * @param pen 节点或连线
   */
  nextNode(pen: Pen): Pen[] {
    if (pen.type === PenType.Line) {
      const nextNode = this.store.pens[getToAnchor(pen).connectTo];
      return nextNode ? [nextNode] : [];
    } else {
      // 1. 得到所有的出线
      const lines = this.getLines(pen, 'out');
      const nextNodes: Pen[] = [];
      // 2. 遍历出线的 nextNode
      lines.forEach((line) => {
        const lineNextNode = this.nextNode(line);
        for (const node of lineNextNode) {
          const have = nextNodes.find((next) => next.id === node.id);
          // 3. 不重复的才加进去
          !have && nextNodes.push(node);
        }
      });
      return nextNodes;
    }
  }

  /**
   * 得到当前节点的上一个节点，即入口节点数组
   * 得到当前连线的入口节点
   * @param pen 节点或连线
   */
  previousNode(pen: Pen): Pen[] {
    if (pen.type === PenType.Line) {
      const preNode = this.store.pens[getFromAnchor(pen).connectTo];
      return preNode ? [preNode] : [];
    } else {
      // 1. 得到所有的入线
      const lines = this.getLines(pen, 'in');
      const preNodes: Pen[] = [];
      // 2. 遍历入线的 preNode
      lines.forEach((line) => {
        const linePreNode = this.previousNode(line);
        for (const node of linePreNode) {
          const have = preNodes.find((pre) => pre.id === node.id);
          // 3. 不重复的才加进去
          !have && preNodes.push(node);
        }
      });
      return preNodes;
    }
  }

  /**
   * 生成一个拷贝组合后的 画笔数组（组合图形），不影响原画布画笔，常用作 二次复用的组件
   * @param pens 画笔数组
   * @param showChild 是否作为状态复用（参考 combine showChild）
   * @returns 组合图形
   */
  toComponent(pens = this.store.data.pens, showChild?: number): Pen[] {
    if (pens.length === 1) {
      const pen: Pen = deepClone(pens[0]);
      pen.type = PenType.Node;
      pen.id = undefined;
      return [pen];
    }

    const components = deepClone(pens, true);
    const rect = getRect(components);
    let parent: Pen = {
      id: s8(),
      name: 'combine',
      ...rect,
      children: [],
      showChild,
    };
    const p = components.find((pen) => {
      return pen.width === rect.width && pen.height === rect.height;
    });
    const oneIsParent = p && showChild === undefined;
    if (oneIsParent) {
      if (!p.children) {
        p.children = [];
      }
      parent = p;
    } else {
      // 不影响画布数据，生成一个组合图形便于二次复用
      // this.canvas.makePen(parent);
    }

    components.forEach((pen) => {
      if (pen === parent || pen.parentId === parent.id) {
        return;
      }
      if (pen.parentId) {
        // 已经是其它节点的子节点，x,y,w,h 已经是百分比了
        return;
      }
      parent.children.push(pen.id);
      pen.parentId = parent.id;
      const childRect = calcRelativeRect(pen.calculative.worldRect, rect);
      Object.assign(pen, childRect);
      pen.locked = LockState.DisableMove;
      // pen.type = PenType.Node;
    });

    return oneIsParent ? deepClone(components) : deepClone([parent, ...components]);
  }

  setVisible(pen: Pen, visible: boolean, render = true) {
    this.onSizeUpdate();
    this._setValue({ id: pen.id, visible });
    if (pen.children) {
      for (const childId of pen.children) {
        const child = this.store.pens[childId];
        child && this.setVisible(child, visible, false);
      }
    }
    render && this.render();
  }

  clearHover(): void {
    this.canvas.clearHover();
  }

  closeSocket() {
    this.closeWebsocket();
    this.closeMqtt();
    this.closeHttp();
  }

  destroy(global?: boolean) {
    for (const pen of this.store.data.pens) {
      pen.onDestroy?.(pen);
    }
    this.closeSocket();
    clearStore(this.store);
    this.store.emitter.all.clear(); // 内存释放
    this.canvas.destroy();
    // Clear data.
    globalStore[this.store.id] = undefined;
    globalStore.path2dDraws = {};
    this.canvas = undefined;

    if (global) {
      globalStore.htmlElements = {};
    }
  }
}
