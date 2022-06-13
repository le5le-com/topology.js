import { LineAnimateType, Pen } from './model';
import { getSplitAnchor, line } from '../diagrams';
import { Direction } from '../data';
import { calcRotate, distance, facePoint, Point, rotatePoint, scalePoint, translatePoint } from '../point';
import {
  calcCenter,
  calcExy,
  calcRelativePoint,
  calcRelativeRect,
  Rect,
  rectInRect,
  scaleRect,
  translateRect,
} from '../rect';
import { globalStore, TopologyStore } from '../store';
import { calcTextLines, calcTextDrawRect } from './text';
import { deepClone } from '../utils/clone';
import { renderFromArrow, renderToArrow } from './arrow';
import { Gradient, isEqual, PenType } from '@topology/core';
import { rgba } from '../utils';
import { Canvas } from '../canvas';

export function getParent(pen: Pen, root?: boolean): Pen {
  if (!pen || !pen.parentId || !pen.calculative) {
    return undefined;
  }

  const store = pen.calculative.canvas.store;
  const parent = store.pens[pen.parentId];
  if (!root) {
    return parent;
  }
  return getParent(parent, root) || parent;
}

export function getAllChildren(pen: Pen, store: TopologyStore): Pen[] {
  if (!pen || !pen.children) {
    return [];
  }
  const children: Pen[] = [];
  pen.children.forEach((id) => {
    const child = store.pens[id];
    if (child) {
      children.push(child);
      children.push(...getAllChildren(child, store));
    }
  });
  return children;
}

function drawBkLinearGradient(ctx: CanvasRenderingContext2D, pen: Pen) {
  const { worldRect, gradientFromColor, gradientToColor, gradientAngle } = pen.calculative;
  return linearGradient(ctx, worldRect, gradientFromColor, gradientToColor, gradientAngle);
}

/**
 * 避免副作用，把创建好后的径向渐变对象返回出来
 * @param ctx 画布绘制对象
 * @param pen 当前画笔
 * @returns 径向渐变
 */
function drawBkRadialGradient(ctx: CanvasRenderingContext2D, pen: Pen) {
  const { worldRect, gradientFromColor, gradientToColor, gradientRadius } = pen.calculative;
  if (!gradientFromColor || !gradientToColor) {
    return;
  }

  const { width, height, center } = worldRect;
  const { x: centerX, y: centerY } = center;
  let r = width;
  if (r < height) {
    r = height;
  }
  r *= 0.5;
  const grd = ctx.createRadialGradient(centerX, centerY, r * (gradientRadius || 0), centerX, centerY, r);
  grd.addColorStop(0, gradientFromColor);
  grd.addColorStop(1, gradientToColor);

  return grd;
}

function strokeLinearGradient(ctx: CanvasRenderingContext2D, pen: Pen) {
  const { worldRect, lineGradientFromColor, lineGradientToColor, lineGradientAngle } = pen.calculative;
  return linearGradient(ctx, worldRect, lineGradientFromColor, lineGradientToColor, lineGradientAngle);
}

/**
 * 避免副作用，把创建好后的线性渐变对象返回出来
 * @param ctx 画布绘制对象
 * @param worldRect 世界坐标
 * @returns 线性渐变
 */
function linearGradient(
  ctx: CanvasRenderingContext2D,
  worldRect: Rect,
  fromColor: string,
  toColor: string,
  angle: number
) {
  if (!fromColor || !toColor) {
    return;
  }

  const { x, y, center, ex, ey } = worldRect;
  const from: Point = {
    x,
    y: center.y,
  };
  const to: Point = {
    x: ex,
    y: center.y,
  };
  if (angle % 90 === 0 && angle % 180) {
    from.x = center.x;
    to.x = center.x;
    if (angle % 270) {
      from.y = y;
      to.y = ey;
    } else {
      from.y = ey;
      to.y = y;
    }
  } else if (angle) {
    rotatePoint(from, angle, worldRect.center);
    rotatePoint(to, angle, worldRect.center);
  }

  // contributor: https://github.com/sunnyguohua/topology
  const grd = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
  grd.addColorStop(0, fromColor);
  grd.addColorStop(1, toColor);
  return grd;
}

export function drawImage(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, pen: Pen) {
  const {
    worldIconRect: rect,
    iconWidth,
    iconHeight,
    imgNaturalWidth,
    imgNaturalHeight,
    iconRotate,
    img,
  } = pen.calculative;
  let { x, y, width: w, height: h } = rect;
  if (iconWidth) {
    w = iconWidth;
  }
  if (iconHeight) {
    h = iconHeight;
  }
  if (imgNaturalWidth && imgNaturalHeight && pen.imageRatio) {
    const scaleW = rect.width / imgNaturalWidth;
    const scaleH = rect.height / imgNaturalHeight;
    const scaleMin = Math.min(scaleW, scaleH);
    const wDivideH = imgNaturalWidth / imgNaturalHeight;
    if (iconWidth) {
      h = iconWidth / wDivideH;
    } else if (iconHeight) {
      w = iconHeight * wDivideH;
    } else {
      w = scaleMin * imgNaturalWidth;
      h = scaleMin * imgNaturalHeight;
    }
  }
  x += (rect.width - w) / 2;
  y += (rect.height - h) / 2;

  switch (pen.iconAlign) {
    case 'top':
      y = rect.y;
      break;
    case 'bottom':
      y = rect.ey - h;
      break;
    case 'left':
      x = rect.x;
      break;
    case 'right':
      x = rect.ex - w;
      break;
    case 'left-top':
      x = rect.x;
      y = rect.y;
      break;
    case 'right-top':
      x = rect.ex - w;
      y = rect.y;
      break;
    case 'left-bottom':
      x = rect.x;
      y = rect.ey - h;
      break;
    case 'right-bottom':
      x = rect.ex - w;
      y = rect.ey - h;
      break;
  }

  if (iconRotate) {
    const { x: centerX, y: centerY } = rect.center;
    ctx.translate(centerX, centerY);
    ctx.rotate((iconRotate * Math.PI) / 180);
    ctx.translate(-centerX, -centerY);
  }
  ctx.drawImage(img, x, y, w, h);
}

/**
 * 获取文字颜色， textColor 优先其次 color
 */
export function getTextColor(pen: Pen, store: TopologyStore) {
  const { textColor, color } = pen.calculative;
  const { data, options } = store;
  return textColor || color || data.color || options.textColor || options.color;
}

function drawText(ctx: CanvasRenderingContext2D, pen: Pen) {
  const {
    fontStyle,
    fontWeight,
    fontSize,
    fontFamily,
    lineHeight,
    text,
    hiddenText,
    canvas,
    textHasShadow,
    textBackground,
  } = pen.calculative;
  if (text == undefined || hiddenText) {
    return;
  }
  const store = canvas.store;
  ctx.save();
  if (!textHasShadow) {
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  let fill: string = undefined;
  if (pen.calculative.hover) {
    fill = pen.hoverTextColor || pen.hoverColor || store.options.hoverColor;
  } else if (pen.calculative.active) {
    fill = pen.activeTextColor || pen.activeColor || store.options.activeColor;
  }
  ctx.fillStyle = fill || getTextColor(pen, store);

  ctx.font = getFont({
    fontStyle,
    fontWeight,
    fontFamily: fontFamily || store.options.fontFamily,
    fontSize,
    lineHeight,
  });

  !pen.calculative.textDrawRect && calcTextDrawRect(ctx, pen);
  const { x: drawRectX, y: drawRectY, width, height } = pen.calculative.textDrawRect;
  if (textBackground) {
    ctx.save();
    ctx.fillStyle = textBackground;
    ctx.fillRect(drawRectX, drawRectY, width, height);
    ctx.restore();
  }

  const y = 0.55;
  const textAlign = pen.textAlign || store.options.textAlign;
  const oneRowHeight = fontSize * lineHeight;
  pen.calculative.textLines.forEach((text, i) => {
    const textLineWidth = pen.calculative.textLineWidths[i];
    let x = 0;
    if (textAlign === 'center') {
      x = (width - textLineWidth) / 2;
    } else if (textAlign === 'right') {
      x = width - textLineWidth;
    }
    ctx.fillText(text, drawRectX + x, drawRectY + (i + y) * oneRowHeight);
  });

  ctx.restore();
}

function drawFillText(ctx: CanvasRenderingContext2D, pen: Pen, text: string) {
  if (text == undefined) {
    return;
  }

  const { fontStyle, fontWeight, fontSize, fontFamily, lineHeight, canvas } = pen.calculative;

  const store = canvas.store;
  ctx.save();

  let fill: string = undefined;
  if (pen.calculative.hover) {
    fill = pen.hoverTextColor || pen.hoverColor || store.options.hoverColor;
  } else if (pen.calculative.active) {
    fill = pen.activeTextColor || pen.activeColor || store.options.activeColor;
  }
  ctx.fillStyle = fill || getTextColor(pen, store);

  ctx.font = getFont({
    fontStyle,
    fontWeight,
    fontFamily: fontFamily || store.options.fontFamily,
    fontSize,
    lineHeight,
  });

  const w = ctx.measureText(text).width;
  let t: string;

  let prev: Point;
  for (const anchor of pen.calculative.worldAnchors) {
    if (!prev) {
      prev = anchor;
      continue;
    }

    const dis = distance(prev, anchor);

    const n = Math.floor(dis / w);
    t = '';
    for (let i = 0; i < n; i++) {
      t += text;
    }

    const angle = calcRotate(prev, anchor) - 270;
    ctx.save();
    if (angle % 360 !== 0) {
      const { x, y } = prev;
      ctx.translate(x, y);
      let rotate = (angle * Math.PI) / 180;
      ctx.rotate(rotate);
      ctx.translate(-x, -y);
    }
    ctx.fillText(t, prev.x, prev.y + lineHeight / 2);
    ctx.restore();
    prev = anchor;
  }

  ctx.restore();
}

export function drawIcon(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, pen: Pen) {
  const store = pen.calculative.canvas.store;
  ctx.save();
  ctx.shadowColor = '';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const iconRect = pen.calculative.worldIconRect;
  let x = iconRect.x + iconRect.width / 2;
  let y = iconRect.y + iconRect.height / 2;

  switch (pen.iconAlign) {
    case 'top':
      y = iconRect.y;
      ctx.textBaseline = 'top';
      break;
    case 'bottom':
      y = iconRect.ey;
      ctx.textBaseline = 'bottom';
      break;
    case 'left':
      x = iconRect.x;
      ctx.textAlign = 'left';
      break;
    case 'right':
      x = iconRect.ex;
      ctx.textAlign = 'right';
      break;
    case 'left-top':
      x = iconRect.x;
      y = iconRect.y;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      break;
    case 'right-top':
      x = iconRect.ex;
      y = iconRect.y;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      break;
    case 'left-bottom':
      x = iconRect.x;
      y = iconRect.ey;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      break;
    case 'right-bottom':
      x = iconRect.ex;
      y = iconRect.ey;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      break;
  }

  const fontWeight = pen.calculative.iconWeight;
  let fontSize: number = undefined;
  const fontFamily = pen.calculative.iconFamily;
  if (pen.calculative.iconSize > 0) {
    fontSize = pen.calculative.iconSize;
  } else if (iconRect.width > iconRect.height) {
    fontSize = iconRect.height;
  } else {
    fontSize = iconRect.width;
  }
  ctx.font = getFont({
    fontSize,
    fontWeight,
    fontFamily,
  });
  ctx.fillStyle = pen.calculative.iconColor || getTextColor(pen, store);

  if (pen.calculative.iconRotate) {
    ctx.translate(iconRect.center.x, iconRect.center.y);
    ctx.rotate((pen.calculative.iconRotate * Math.PI) / 180);
    ctx.translate(-iconRect.center.x, -iconRect.center.y);
  }

  ctx.beginPath();
  ctx.fillText(pen.calculative.icon, x, y);
  ctx.restore();
}

/**
 * canvas2svg 中对 font 的解析规则比 canvas 中简单，能识别的类型很少
 * @returns ctx.font
 */
export function getFont({
  fontStyle = 'normal',
  textDecoration = 'normal',
  fontWeight = 'normal',
  fontSize = 12,
  fontFamily = 'Arial',
  lineHeight = 1, // TODO: lineHeight 默认值待测试
}: {
  fontStyle?: string;
  textDecoration?: string;
  fontWeight?: string;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
} = {}) {
  return `${fontStyle} ${textDecoration} ${fontWeight} ${fontSize}px/${lineHeight} ${fontFamily}`;
}

// TODO: 0.5 偏移量在 图片中可能存在问题
export function ctxFlip(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, pen: Pen) {
  // worldRect 可能为 undefined
  const { x, ex, y, ey } = pen.calculative.worldRect || {};
  if (pen.calculative.flipX) {
    ctx.translate(x + ex + 0.5, 0.5);
    ctx.scale(-1, 1);
  }
  if (pen.calculative.flipY) {
    ctx.translate(0.5, y + ey + 0.5);
    ctx.scale(1, -1);
  }
}

export function ctxRotate(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, pen: Pen) {
  const { x, y } = pen.calculative.worldRect.center;
  ctx.translate(x, y);
  let rotate = (pen.calculative.rotate * Math.PI) / 180;
  // 目前只有水平和垂直翻转，都需要 * -1
  if (pen.calculative.flipX) {
    rotate *= -1;
  } else if (pen.calculative.flipY) {
    rotate *= -1;
  }
  ctx.rotate(rotate);
  ctx.translate(-x, -y);
}

export function renderPen(ctx: CanvasRenderingContext2D, pen: Pen) {
  ctx.save();
  ctx.translate(0.5, 0.5);
  ctx.beginPath();

  ctxFlip(ctx, pen);

  if (pen.calculative.rotate && pen.name !== 'line') {
    ctxRotate(ctx, pen);
  }

  if (pen.calculative.lineWidth > 1) {
    ctx.lineWidth = pen.calculative.lineWidth;
  }

  const store = pen.calculative.canvas.store;

  inspectRect(ctx, store, pen); // 审查 rect
  let fill: any;
  // 该变量控制在 hover active 状态下的节点是否设置填充颜色
  let setBack = true;
  if (pen.calculative.hover) {
    ctx.strokeStyle = pen.hoverColor || store.options.hoverColor;
    fill = pen.hoverBackground || store.options.hoverBackground;
    ctx.fillStyle = fill;
    fill && (setBack = false);
  } else if (pen.calculative.active) {
    ctx.strokeStyle = pen.activeColor || store.options.activeColor;
    fill = pen.activeBackground || store.options.activeBackground;
    ctx.fillStyle = fill;
    fill && (setBack = false);
  } else if (pen.calculative.isDock) {
    if (pen.type === PenType.Line) {
      ctx.strokeStyle = store.options.dockPenColor;
    } else {
      fill = rgba(store.options.dockPenColor, 0.2);
      ctx.fillStyle = fill;
      fill && (setBack = false);
    }
  } else {
    const strokeImg = pen.calculative.strokeImg;
    if (pen.calculative.strokeImage && strokeImg) {
      ctx.strokeStyle = ctx.createPattern(strokeImg, 'repeat');
      fill = true;
    } else {
      let stroke: string | CanvasGradient | CanvasPattern;
      // TODO: 线只有线性渐变
      if (pen.calculative.strokeType === Gradient.Linear) {
        stroke = strokeLinearGradient(ctx, pen);
      } else {
        stroke = pen.calculative.color;
      }
      ctx.strokeStyle = stroke;
    }
  }
  if (setBack) {
    const backgroundImg = pen.calculative.backgroundImg;
    if (pen.calculative.backgroundImage && backgroundImg) {
      ctx.fillStyle = ctx.createPattern(backgroundImg, 'repeat');
      fill = true;
    } else {
      let back: string | CanvasGradient | CanvasPattern;
      if (pen.calculative.bkType === Gradient.Linear) {
        back = drawBkLinearGradient(ctx, pen);
      } else if (pen.calculative.bkType === Gradient.Radial) {
        back = drawBkRadialGradient(ctx, pen);
      } else {
        back = pen.calculative.background || store.data.penBackground;
      }
      ctx.fillStyle = back;
      fill = !!back;
    }
  }

  setLineCap(ctx, pen);
  setLineJoin(ctx, pen);

  setGlobalAlpha(ctx, pen);

  if (pen.calculative.lineDash) {
    ctx.setLineDash(pen.calculative.lineDash);
  }
  if (pen.calculative.lineDashOffset) {
    ctx.lineDashOffset = pen.calculative.lineDashOffset;
  }

  if (pen.calculative.shadowColor) {
    ctx.shadowColor = pen.calculative.shadowColor;
    ctx.shadowOffsetX = pen.calculative.shadowOffsetX;
    ctx.shadowOffsetY = pen.calculative.shadowOffsetY;
    ctx.shadowBlur = pen.calculative.shadowBlur;
  }

  ctxDrawPath(true, ctx, pen, store, fill);

  ctxDrawCanvas(ctx, pen);

  if (!(pen.image && pen.calculative.img) && pen.calculative.icon) {
    drawIcon(ctx, pen);
  }

  drawText(ctx, pen);

  if (pen.type === PenType.Line && pen.fillTexts) {
    for (const text of pen.fillTexts) {
      drawFillText(ctx, pen, text);
    }
  }

  ctx.restore();
}

/**
 * 更改 ctx 的 lineCap 属性
 */
export function setLineCap(ctx: CanvasRenderingContext2D, pen: Pen) {
  const lineCap = pen.lineCap;
  if (lineCap) {
    ctx.lineCap = lineCap;
  } else if (pen.type) {
    ctx.lineCap = 'round';
  }
}

/**
 * 更改 ctx 的 lineJoin 属性
 */
export function setLineJoin(ctx: CanvasRenderingContext2D, pen: Pen) {
  const lineJoin = pen.lineJoin;
  if (lineJoin) {
    ctx.lineJoin = lineJoin;
  } else if (pen.type) {
    ctx.lineJoin = 'round';
  }
}

/**
 * 通常用在下载 svg
 * canvas2svg 与 canvas ctx 设置 strokeStyle 表现不同
 * 若设置值为 undefined ，canvas2svg 为空， canvas ctx 为上一个值
 */
export function renderPenRaw(ctx: CanvasRenderingContext2D, pen: Pen, rect?: Rect) {
  ctx.save();
  if (rect) {
    ctx.translate(-rect.x, -rect.y);
  }

  // for canvas2svg
  (ctx as any).setAttrs?.(pen);
  // end

  ctx.beginPath();
  if (pen.calculative.flipX) {
    if (rect) {
      ctx.translate(pen.calculative.worldRect.x + pen.calculative.worldRect.ex - rect.x, -rect.y);
    } else {
      ctx.translate(pen.calculative.worldRect.x + pen.calculative.worldRect.ex, 0);
    }
    ctx.scale(-1, 1);
  }
  if (pen.calculative.flipY) {
    if (rect) {
      ctx.translate(-rect.x, pen.calculative.worldRect.y + pen.calculative.worldRect.ey - rect.x);
    } else {
      ctx.translate(0, pen.calculative.worldRect.y + pen.calculative.worldRect.ey);
    }
    ctx.scale(1, -1);
  }

  if (pen.calculative.rotate && pen.name !== 'line') {
    ctxRotate(ctx, pen);
  }

  if (pen.calculative.lineWidth > 1) {
    ctx.lineWidth = pen.calculative.lineWidth;
  }

  const store = pen.calculative.canvas.store;

  let fill: any;
  if (pen.calculative.hover) {
    ctx.strokeStyle = pen.hoverColor || store.options.hoverColor;
    ctx.fillStyle = pen.hoverBackground || store.options.hoverBackground;
    fill = pen.hoverBackground || store.options.hoverBackground;
  } else if (pen.calculative.active) {
    ctx.strokeStyle = pen.activeColor || store.options.activeColor;
    ctx.fillStyle = pen.activeBackground || store.options.activeBackground;
    fill = pen.activeBackground || store.options.activeBackground;
  } else {
    if (pen.strokeImage) {
      if (pen.calculative.strokeImg) {
        ctx.strokeStyle = ctx.createPattern(pen.calculative.strokeImg, 'repeat');
        fill = true;
      }
    } else {
      ctx.strokeStyle = pen.calculative.color || getGlobalColor(store);
    }

    if (pen.backgroundImage) {
      if (pen.calculative.backgroundImg) {
        ctx.fillStyle = ctx.createPattern(pen.calculative.backgroundImg, 'repeat');
        fill = true;
      }
    } else {
      ctx.fillStyle = pen.background;
      fill = !!pen.background;
    }
  }

  setLineCap(ctx, pen);
  setLineJoin(ctx, pen);

  setGlobalAlpha(ctx, pen);

  if (pen.calculative.lineDash) {
    ctx.setLineDash(pen.calculative.lineDash);
  }
  if (pen.calculative.lineDashOffset) {
    ctx.lineDashOffset = pen.calculative.lineDashOffset;
  }

  if (pen.calculative.shadowColor) {
    ctx.shadowColor = pen.calculative.shadowColor;
    ctx.shadowOffsetX = pen.calculative.shadowOffsetX;
    ctx.shadowOffsetY = pen.calculative.shadowOffsetY;
    ctx.shadowBlur = pen.calculative.shadowBlur;
  }

  ctxDrawPath(false, ctx, pen, store, fill);

  ctxDrawCanvas(ctx, pen);

  // renderPenRaw 用在 downloadPng svg , echarts 等图形需要
  if (pen.calculative.img) {
    ctx.save();
    ctx.shadowColor = '';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    drawImage(ctx, pen);
    ctx.restore();
  } else if (pen.calculative.icon) {
    drawIcon(ctx, pen);
  }

  drawText(ctx, pen);

  if (pen.type === PenType.Line && pen.fillTexts) {
    for (const text of pen.fillTexts) {
      drawFillText(ctx, pen, text);
    }
  }

  ctx.restore();
}

/**
 * 根据 path2D 绘制 path
 * @param canUsePath 是否可使用 Path2D, downloadSvg 不可使用 path2D
 */
export function ctxDrawPath(
  canUsePath = true,
  ctx: CanvasRenderingContext2D,
  pen: Pen,
  store: TopologyStore,
  fill: boolean
) {
  const path = canUsePath ? store.path2dMap.get(pen) : globalStore.path2dDraws[pen.name];
  if (path) {
    if (pen.type === PenType.Line && pen.borderWidth) {
      ctx.save();
      ctx.beginPath();
      const lineWidth = pen.calculative.lineWidth + pen.calculative.borderWidth;
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = pen.borderColor;
      if (path instanceof Path2D) {
        fill && ctx.fill(path);
        lineWidth && ctx.stroke(path);
      } else {
        path(pen, ctx);
        fill && ctx.fill();
        lineWidth && ctx.stroke();
      }
      ctx.restore();
    }
    if (path instanceof Path2D) {
      fill && ctx.fill(path);
    } else {
      ctx.save();
      path(pen, ctx);
      fill && ctx.fill();
      ctx.restore();
    }

    const progress = pen.calculative.progress;
    if (progress != null) {
      ctx.save();
      const { x, y, width, height, ey } = pen.calculative.worldRect;
      const grd = !pen.verticalProgress
        ? ctx.createLinearGradient(x, y, x + width * progress, y)
        : ctx.createLinearGradient(x, ey, x, y + height * (1 - progress));
      const color = pen.calculative.progressColor || pen.calculative.color || store.options.activeColor;
      grd.addColorStop(0, color);
      grd.addColorStop(1, color);
      grd.addColorStop(1, 'transparent');

      ctx.fillStyle = grd;
      if (path instanceof Path2D) {
        ctx.fill(path);
      } else {
        path(pen, ctx);
        ctx.fill();
      }
      ctx.restore();
    }

    if (pen.calculative.lineWidth) {
      if (path instanceof Path2D) {
        ctx.stroke(path);
      } else {
        path(pen, ctx);
        ctx.stroke();
      }
    }

    if (pen.type) {
      if (pen.calculative.animatePos) {
        ctx.save();
        setCtxLineAnimate(ctx, pen, store);
        if (path instanceof Path2D) {
          ctx.stroke(path);
        } else {
          path(pen, ctx);
          ctx.stroke();
        }
        ctx.restore();
      }

      pen.fromArrow && renderFromArrow(ctx, pen, store);
      pen.toArrow && renderToArrow(ctx, pen, store);

      if (pen.calculative.active && !pen.calculative.pencil) {
        renderLineAnchors(ctx, pen);
      }
    }
  }
}

/**
 * 设置线条动画，ctx 的 strokeStyle lineDash 等属性更改
 */
export function setCtxLineAnimate(ctx: CanvasRenderingContext2D, pen: Pen, store: TopologyStore) {
  ctx.strokeStyle = pen.animateColor || store.options.animateColor;
  let len = 0;
  switch (pen.lineAnimateType) {
    case LineAnimateType.Beads:
      if (pen.animateReverse) {
        ctx.lineDashOffset = pen.calculative.animatePos;
      } else {
        ctx.lineDashOffset = pen.length - pen.calculative.animatePos;
      }
      len = pen.calculative.lineWidth || 5;
      if (len < 5) {
        len = 5;
      }
      ctx.setLineDash(pen.animateLineDash || [len, len * 2]);
      break;
    case LineAnimateType.Dot:
      if (pen.animateReverse) {
        ctx.lineDashOffset = pen.calculative.animatePos;
      } else {
        ctx.lineDashOffset = pen.length - pen.calculative.animatePos;
      }
      len = pen.calculative.animateDotSize || pen.calculative.lineWidth * 2 || 6;
      if (len < 6) {
        len = 6;
      }
      ctx.lineWidth = len;
      ctx.setLineDash([0.1, pen.length]);
      break;
    default:
      if (pen.animateReverse) {
        ctx.setLineDash([0, pen.length - pen.calculative.animatePos + 1, pen.calculative.animatePos]);
      } else {
        ctx.setLineDash([pen.calculative.animatePos, pen.length - pen.calculative.animatePos]);
      }
      break;
  }
}

/**
 * 全局 color
 */
export function getGlobalColor(store: TopologyStore) {
  const { data, options } = store;
  return data.color || options.color;
}

export function renderLineAnchors(ctx: CanvasRenderingContext2D, pen: Pen) {
  const store = pen.calculative.canvas.store;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.fillStyle = pen.activeColor || store.options.activeColor;
  pen.calculative.worldAnchors.forEach((pt) => {
    !pt.hidden && !pt.isTemp && renderAnchor(ctx, pt, pen);
  });
  ctx.restore();
}

export function renderAnchor(ctx: CanvasRenderingContext2D, pt: Point, pen: Pen) {
  if (!pt) {
    return;
  }

  const active = pen.calculative.activeAnchor === pt;
  let r = 3;
  if (pen.calculative.lineWidth > 3) {
    r = pen.calculative.lineWidth;
  }

  if (active) {
    if (pt.prev) {
      ctx.save();
      ctx.strokeStyle = '#4dffff';
      ctx.beginPath();
      ctx.moveTo(pt.prev.x, pt.prev.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(pt.prev.x, pt.prev.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    if (pt.next) {
      ctx.save();
      ctx.strokeStyle = '#4dffff';
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(pt.next.x, pt.next.y);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(pt.next.x, pt.next.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export function calcWorldRects(pen: Pen) {
  const store: TopologyStore = pen.calculative.canvas.store;

  let rect: Rect = {
    x: pen.x,
    y: pen.y,
  };

  if (!pen.parentId) {
    rect.width = pen.width;
    rect.height = pen.height;
    rect.rotate = pen.rotate;
    calcExy(rect);
    calcCenter(rect);
  } else {
    const parent = store.pens[pen.parentId];
    let parentRect = parent.calculative.worldRect;
    if (!parentRect) {
      parentRect = calcWorldRects(parent);
    }

    rect.x = parentRect.x + parentRect.width * pen.x;
    rect.y = parentRect.y + parentRect.height * pen.y;
    rect.width = parentRect.width * pen.width;
    rect.height = parentRect.height * pen.height;
    if (parent.flipX) {
      rect.x = parentRect.width - (rect.x - parentRect.x + rect.width) + parentRect.x;
    }
    if (parent.flipY) {
      rect.y = parentRect.height - (rect.y - parentRect.y + rect.height) + parentRect.y;
    }

    calcExy(rect);

    rect.rotate = parentRect.rotate + pen.rotate;
    calcCenter(rect);
  }

  pen.calculative.worldRect = rect;
  // 这里的 rect 均是绝对值
  calcPadding(pen, rect);

  return rect;
}

export function calcPadding(pen: Pen, rect: Rect) {
  !pen.paddingTop && (pen.calculative.paddingTop = 0);
  !pen.paddingBottom && (pen.calculative.paddingBottom = 0);
  !pen.paddingLeft && (pen.calculative.paddingLeft = 0);
  !pen.paddingRight && (pen.calculative.paddingRight = 0);

  pen.calculative.paddingTop < 1 && (pen.calculative.paddingTop *= rect.height);
  pen.calculative.paddingBottom < 1 && (pen.calculative.paddingBottom *= rect.height);
  pen.calculative.paddingLeft < 1 && (pen.calculative.paddingLeft *= rect.width);
  pen.calculative.paddingRight < 1 && (pen.calculative.paddingRight *= rect.width);
}

export function calcPenRect(pen: Pen) {
  const worldRect = pen.calculative.worldRect;
  if (!pen.parentId) {
    Object.assign(pen, worldRect);
    return;
  }
  const store = pen.calculative.canvas.store;
  const parentRect = store.pens[pen.parentId].calculative.worldRect;
  Object.assign(pen, calcRelativeRect(worldRect, parentRect));
}

export function calcWorldAnchors(pen: Pen) {
  const store: TopologyStore = pen.calculative.canvas.store;
  let anchors: Point[] = [];
  if (pen.anchors) {
    pen.anchors.forEach((anchor) => {
      anchors.push(calcWorldPointOfPen(pen, anchor));
    });
  }

  // Default anchors of node
  if (!anchors.length && !pen.type && pen.name !== 'combine') {
    const { x, y, width, height } = pen.calculative.worldRect;
    anchors = store.options.defaultAnchors.map((anchor, index) => {
      return {
        id: `${index}`,
        penId: pen.id,
        x: x + width * anchor.x,
        y: y + height * anchor.y,
      };
    });
  }

  if (pen.calculative.rotate) {
    anchors.forEach((anchor) => {
      rotatePoint(anchor, pen.calculative.rotate, pen.calculative.worldRect.center);
    });
  }

  if (!pen.type || pen.anchors) {
    pen.calculative.worldAnchors = anchors;
  }

  if (pen.calculative.activeAnchor && anchors.length) {
    pen.calculative.activeAnchor = anchors.find((a) => {
      a.id === pen.calculative.activeAnchor.id;
    });
  }
}

export function calcWorldPointOfPen(pen: Pen, pt: Point) {
  const p: Point = { ...pt };
  const { x, y, width, height } = pen.calculative.worldRect;
  p.x = x + width * pt.x;
  p.y = y + height * pt.y;
  if (pt.prev) {
    p.prev = {
      penId: pen.id,
      connectTo: pt.prev.connectTo,
      x: x + width * pt.prev.x,
      y: y + height * pt.prev.y,
    };
  }
  if (pt.next) {
    p.next = {
      penId: pen.id,
      connectTo: pt.next.connectTo,
      x: x + width * pt.next.x,
      y: y + height * pt.next.y,
    };
  }

  return p;
}

export function calcIconRect(pens: { [key: string]: Pen }, pen: Pen) {
  const { paddingTop, paddingBottom, paddingLeft, paddingRight } = pen.calculative;
  let x = paddingLeft;
  let y = paddingTop;
  let width = pen.calculative.worldRect.width - paddingLeft - paddingRight;
  let height = pen.calculative.worldRect.height - paddingTop - paddingBottom;
  let iconLeft = pen.calculative.iconLeft;
  let iconTop = pen.calculative.iconTop;
  if (iconLeft && Math.abs(iconLeft) < 1) {
    iconLeft = pen.calculative.worldRect.width * iconLeft;
  }

  if (iconTop && Math.abs(iconTop) < 1) {
    iconTop = pen.calculative.worldRect.height * iconTop;
  }
  x += iconLeft || 0;
  y += iconTop || 0;
  width -= iconLeft || 0;
  height -= iconTop || 0;

  let rotate = pen.calculative.iconRotate || 0;
  if (pen.parentId) {
    const parentPen = pens[pen.parentId].calculative;
    if (parentPen) {
      rotate += parentPen.rotate;
      rotate %= 360;
    }
  }

  x = pen.calculative.worldRect.x + x;
  y = pen.calculative.worldRect.y + y;
  pen.calculative.worldIconRect = {
    x,
    y,
    width,
    height,
    rotate,
  };
  calcExy(pen.calculative.worldIconRect);
  calcCenter(pen.calculative.worldIconRect);
}

export function scalePen(pen: Pen, scale: number, center: Point) {
  scaleRect(pen.calculative.worldRect, scale, center);

  if (pen.calculative.initRect) {
    scaleRect(pen.calculative.initRect, scale, center);
  }
  if (pen.calculative.x) {
    scalePoint(pen.calculative as any as Point, scale, center);
  }

  if (pen.type) {
    calcWorldAnchors(pen);
  }
}

export function pushPenAnchor(pen: Pen, pt: Point) {
  if (!pen.anchors) {
    pen.anchors = [];
  }
  if (!pen.calculative.worldAnchors) {
    pen.calculative.worldAnchors = [];
  }

  const worldAnchor = {
    id: pt.id,
    penId: pen.id,
    x: pt.x,
    y: pt.y,
  };
  pen.calculative.worldAnchors.push(worldAnchor);

  if (pen.calculative.worldRect) {
    if (pen.rotate % 360) {
      rotatePoint(pt, -pen.rotate, pen.calculative.worldRect.center);
    }

    const anchor = {
      id: pt.id,
      penId: pen.id,
      x: (pt.x - pen.calculative.worldRect.x) / pen.calculative.worldRect.width,
      y: (pt.y - pen.calculative.worldRect.y) / pen.calculative.worldRect.height,
    };
    pen.anchors.push(anchor);
  }

  return worldAnchor;
}

export function addLineAnchor(pen: Pen, pt: Point, index: number) {
  if (!pen.anchors) {
    pen.anchors = [];
  }
  if (!pen.calculative.worldAnchors) {
    pen.calculative.worldAnchors = [];
  }

  const worldAnchor = getSplitAnchor(pen, pt, index);
  pen.calculative.worldAnchors.splice(index + 1, 0, worldAnchor);
  pen.anchors.splice(index + 1, 0, calcRelativePoint(worldAnchor, pen.calculative.worldRect));
  pen.calculative.activeAnchor = worldAnchor;
  return worldAnchor;
}

export function removePenAnchor(pen: Pen, anchor: Point) {
  if (!pen || !pen.calculative.worldAnchors) {
    return;
  }
  let i = pen.calculative.worldAnchors.findIndex((a) => a.id === anchor.id);
  if (i > -1) {
    pen.calculative.worldAnchors.splice(i, 1);
  }

  i = pen.anchors.findIndex((a) => a.id === anchor.id);
  if (i > -1) {
    pen.anchors.splice(i, 1);
  }
}

export function facePen(pt: Point, pen?: Pen) {
  if (!pen || !pen.calculative || !pen.calculative.worldRect.center) {
    return Direction.None;
  }

  return facePoint(pt, pen.calculative.worldRect.center);
}

export function nearestAnchor(pen: Pen, pt: Point) {
  let dis = Infinity;
  let anchor: Point;
  pen.calculative.worldAnchors.forEach((a: Point) => {
    const d = distance(pt, a);
    if (dis > d) {
      dis = d;
      anchor = a;
    }
  });

  return anchor;
}

export function translateLine(pen: Pen, x: number, y: number) {
  pen.x += x;
  pen.y += y;

  if (pen.anchors) {
    pen.anchors.forEach((a) => {
      translatePoint(a, x, y);
    });
  }

  if (pen.calculative.worldAnchors) {
    pen.calculative.worldAnchors.forEach((a) => {
      translatePoint(a, x, y);
    });
  }
}

export function deleteTempAnchor(pen: Pen) {
  if (pen && pen.calculative && pen.calculative.worldAnchors.length) {
    let to: Point = getToAnchor(pen);
    while (pen.calculative.worldAnchors.length && to !== pen.calculative.activeAnchor) {
      pen.calculative.worldAnchors.pop();
      to = getToAnchor(pen);
    }
  }
}

/**
 * 添加line到pen的connectedLines中，并关联相关属性
 * 不添加连线到画布中，请确保画布中已经有该连线。
 * 不改动 line.anchors 中的 connectTo 和 anchorId ，请手动更改
 * */
export function connectLine(pen: Pen, lineId: string, lineAnchor: string, anchor: string) {
  if (!pen || !lineId || !lineAnchor || !anchor) {
    return;
  }

  if (!pen.connectedLines) {
    pen.connectedLines = [];
  }

  const i = pen.connectedLines.findIndex(
    (item) => item.lineId === lineId && item.lineAnchor === lineAnchor && item.anchor === anchor
  );

  if (i < 0) {
    pen.connectedLines.push({
      lineId,
      lineAnchor,
      anchor,
    });
  }
}

/**
 * 从 pen.connectedLines 中删除 lineId 和 lineAnchor
 * 不改动 line.anchors 中的 connectTo 和 anchorId ，请手动更改
 */
export function disconnectLine(pen: Pen, lineId: string, lineAnchor: string, anchor: string) {
  if (!pen || !lineId || !lineAnchor || !anchor) {
    return;
  }

  if (!pen.connectedLines) {
    pen.connectedLines = [];
  }

  const i = pen.connectedLines.findIndex(
    (item) => item.lineId === lineId && item.lineAnchor === lineAnchor && item.anchor === anchor
  );
  i > -1 && pen.connectedLines.splice(i, 1);
}

export function getAnchor(pen: Pen, anchorId: string) {
  if (!pen || !anchorId) {
    return;
  }

  return pen.calculative.worldAnchors?.find((item) => item.id === anchorId);
}

export function getFromAnchor(pen: Pen) {
  if (!pen || !pen.calculative.worldAnchors) {
    return;
  }

  return pen.calculative.worldAnchors[0];
}

export function getToAnchor(pen: Pen) {
  if (!pen || !pen.calculative.worldAnchors) {
    return;
  }

  // return pen.calculative.worldAnchors.at(-1);
  return pen.calculative.worldAnchors[pen.calculative.worldAnchors.length - 1];
}

export function setNodeAnimate(pen: Pen, now: number) {
  if (pen.calculative.start === 0 || !pen.frames || !pen.frames.length) {
    pen.calculative.start = undefined;
    return 0;
  }
  if (!pen.calculative.duration) {
    pen.calculative.duration = 0;
    for (const f of pen.frames) {
      pen.calculative.duration += f.duration;
      for (const k in f) {
        if (k !== 'duration' && !pen[k]) {
          if (k === 'scale') {
            pen[k] = 1;
          }
        }
      }
    }
  }
  if (!pen.animateCycle) {
    pen.animateCycle = Infinity;
  }

  if (!pen.calculative.start) {
    pen.calculative.start = now;
    pen.calculative.frameIndex = 0;
    pen.calculative.frameStart = pen.calculative.start;
    pen.calculative.frameDuration = pen.frames[0].duration;
    pen.calculative.frameEnd = pen.calculative.frameStart + pen.calculative.frameDuration;
    pen.calculative.cycleIndex = 1;

    pen.lastFrame = {};
    for (const k in pen) {
      if (typeof pen[k] !== 'object' || k === 'lineDash') {
        pen.lastFrame[k] = pen[k];
      }
    }
    pen.lastFrame.rotate = 0;
    pen.lastFrame.x = 0;
    pen.lastFrame.y = 0;
    pen.lastFrame.scale = 1;
    pen.calculative.x = pen.calculative.worldRect.x;
    pen.calculative.y = pen.calculative.worldRect.y;
    pen.calculative.initRect = deepClone(pen.calculative.worldRect);
    pen.calculative.initRect.rotate = pen.calculative.rotate || 0;
  } else {
    let frameIndex = 0;
    const cycleCount = Math.ceil((now - pen.calculative.start) / pen.calculative.duration);
    // 播放结束
    if (cycleCount > pen.animateCycle) {
      pen.calculative.start = undefined;
      setNodeAnimateProcess(pen, 1);
      return 0;
    }

    const pos = (now - pen.calculative.start) % pen.calculative.duration;
    let d = 0;
    for (const frame of pen.frames) {
      d += frame.duration;
      if (pos > d) {
        ++frameIndex;
      } else {
        break;
      }
    }
    // 帧超出
    if (!pen.frames[frameIndex]) {
      return true;
    }

    pen.calculative.frameDuration = pen.frames[frameIndex].duration;
    pen.calculative.frameStart = pen.calculative.start + pen.calculative.duration * (cycleCount - 1);
    pen.calculative.frameEnd = pen.calculative.frameStart + pen.calculative.frameDuration;

    // 换帧
    const frameChanged = frameIndex !== pen.calculative.frameIndex;
    // 新循环播放
    const cycleChanged = cycleCount > pen.calculative.cycleIndex;

    frameChanged && (pen.calculative.frameIndex = frameIndex);
    cycleChanged && (pen.calculative.cycleIndex = cycleCount);

    if (frameChanged || cycleChanged) {
      // 已初始位置为参考点。因为网页在后台时，不执行动画帧，网页恢复显示时，位置不确定
      pen.calculative.x = pen.calculative.initRect.x;
      pen.calculative.y = pen.calculative.initRect.y;
      pen.calculative.rotate = pen.calculative.initRect.rotate || 0;

      pen.lastFrame = {};
      const frame = pen.frames[frameIndex - 1];
      for (const k in frame) {
        pen.lastFrame[k] = frame[k];
      }

      if (frameIndex > 0) {
        Object.assign(pen.lastFrame, {
          rotate: pen.frames[frameIndex - 1].rotate || 0,
          x: pen.frames[frameIndex - 1].x || 0,
          y: pen.frames[frameIndex - 1].y || 0,
          scale: pen.frames[frameIndex - 1].scale || 1,
        });
      } else {
        Object.assign(pen.lastFrame, {
          rotate: 0,
          x: 0,
          y: 0,
          scale: 1,
        });
      }
    }
  }

  const process = ((now - pen.calculative.frameStart) / pen.calculative.frameDuration) % 1;
  setNodeAnimateProcess(pen, process);

  return true;
}

// 根据process进度值（纯小数），计算节点动画属性
export function setNodeAnimateProcess(pen: Pen, process: number) {
  if (process < 0) {
    return;
  }

  if (process > 1) {
    process = 1;
  }

  const frame = pen.frames[pen.calculative.frameIndex];
  for (const k in frame) {
    if (k === 'duration') {
      continue;
    } else if (k === 'scale') {
      pen.calculative.worldRect = deepClone(pen.calculative.initRect);
      scaleRect(pen.calculative.worldRect, pen.lastFrame.scale, pen.calculative.worldRect.center);
      const newScale = pen.lastFrame.scale + (frame[k] - pen.lastFrame.scale) * process;
      scaleRect(pen.calculative.worldRect, newScale / pen.lastFrame.scale, pen.calculative.worldRect.center);
      pen.calculative.dirty = true;
    } else if (k === 'x') {
      const lastVal = getFrameValue(pen, k, pen.calculative.frameIndex);
      pen.calculative.worldRect.x = pen.calculative.initRect.x + lastVal;
      pen.calculative.worldRect.ex = pen.calculative.initRect.ex + lastVal;
      translateRect(pen.calculative.worldRect, frame[k] * process * pen.calculative.canvas.store.data.scale, 0);
      pen.calculative.dirty = true;
    } else if (k === 'y') {
      const lastVal = getFrameValue(pen, k, pen.calculative.frameIndex);
      pen.calculative.worldRect.y = pen.calculative.initRect.y + lastVal;
      pen.calculative.worldRect.ey = pen.calculative.initRect.ey + lastVal;
      translateRect(pen.calculative.worldRect, 0, frame[k] * process * pen.calculative.canvas.store.data.scale);
      pen.calculative.dirty = true;
    } else if (k === 'rotate') {
      if (pen.lastFrame[k] >= 360) {
        pen.lastFrame[k] %= 360;
      }
      const lastVal = getFrameValue(pen, k, pen.calculative.frameIndex);
      pen.calculative.rotate = (pen.calculative.initRect.rotate + lastVal + frame[k] * process) % 360;
      pen.calculative.dirty = true;
    } else if (isLinear(frame[k], k, pen)) {
      if (pen.lastFrame[k] == null) {
        if (k === 'globalAlpha') {
          pen.lastFrame[k] = 1;
        } else {
          pen.lastFrame[k] = 0;
        }
      }

      const current = pen.lastFrame[k] + (frame[k] - pen.lastFrame[k]) * process;
      pen.calculative[k] = Math.round(current * 100) / 100;
    } else {
      pen.calculative[k] = frame[k];
    }

    if (k === 'text') {
      calcTextLines(pen);
    }
  }
}

/**
 * 值类型为 number , pen.linear 为 false 时，且 key 不属于 noLinear 时，返回 true
 * @param value 值
 * @param key 键值
 * @param pen 画笔
 * @returns
 */
function isLinear(value: unknown, key: string, pen: Pen): boolean {
  // 不线性变化的属性
  const noLinear = ['strokeType', 'bkType', 'showChild'] as const;
  type NoLinear = typeof noLinear[number];
  return typeof value === 'number' && pen.linear !== false && !noLinear.includes(key as NoLinear);
}

export function setLineAnimate(pen: Pen, now: number) {
  if (pen.calculative.start === 0) {
    pen.calculative.start = undefined;
    return 0;
  }

  if (!pen.animateCycle) {
    pen.animateCycle = Infinity;
  }

  if (!pen.animateSpan) {
    pen.animateSpan = 1;
  }

  pen.calculative.animatePos += pen.animateSpan * (pen.calculative.canvas.store.data.scale || 1);
  if (!pen.calculative.start) {
    pen.calculative.start = Date.now();
    pen.calculative.animatePos = pen.animateSpan * (pen.calculative.canvas.store.data.scale || 1);
    pen.calculative.cycleIndex = 1;
  } else if (pen.calculative.animatePos > pen.length) {
    // 播放到尾了
    ++pen.calculative.cycleIndex;

    // 播放结束
    if (pen.calculative.cycleIndex > pen.animateCycle) {
      pen.calculative.start = undefined;
      return 0;
    }
    pen.calculative.animatePos = pen.animateSpan;
  }

  return true;
}

export function setChildrenActive(pen: Pen, active = true) {
  if (!pen.children) {
    return;
  }
  const store = pen.calculative.canvas.store;
  pen.children.forEach((id) => {
    const child: Pen = store.pens[id];
    if (child) {
      child.calculative.active = active;

      setChildrenActive(child, active);
    }
  });
}

export function setHover(pen: Pen, hover = true) {
  if (!pen) {
    return;
  }
  const store = pen.calculative.canvas.store;
  pen.calculative.hover = hover;
  if (pen.children) {
    pen.children.forEach((id) => {
      // 子节点没有自己的独立hover，继承父节点hover
      if (store.pens[id]?.hoverColor == null && store.pens[id]?.hoverBackground == null) {
        setHover(store.pens[id], hover);
      }
    });
  }
}

export function setElemPosition(pen: Pen, elem: HTMLElement) {
  if (!elem) {
    return;
  }
  const store = pen.calculative.canvas.store;
  const worldRect = pen.calculative.worldRect;
  elem.style.position = 'absolute';
  elem.style.outline = 'none';
  elem.style.left = worldRect.x + store.data.x + 'px';
  elem.style.top = worldRect.y + store.data.y + 'px';
  elem.style.width = worldRect.width + 'px';
  elem.style.height = worldRect.height + 'px';
  elem.style.display = pen.calculative.inView != false ? 'inline' : 'none'; // 是否隐藏元素
  !pen.calculative.rotate && (pen.calculative.rotate = 0);
  elem.style.transform = `rotate(${pen.calculative.rotate}deg)`;
  if (pen.locked || store.data.locked) {
    // TODO: gif 组合后成子节点 locked = 2 导致可选择 dom 无法拖拽
    elem.style.userSelect = 'initial';
    elem.style.pointerEvents = 'initial';
  } else {
    elem.style.userSelect = 'none';
    elem.style.pointerEvents = 'none';
  }
}

/**
 * 每个画笔 locked
 * @param pens 画笔
 * @returns
 */
export function getPensLock(pens: Pen[]): boolean {
  return pens.every((pen) => pen.locked);
}

/**
 * 画笔们的 disabledRotate = true
 * 即 全部禁止旋转 返回 true
 * @param pens 画笔
 * @returns
 */
export function getPensDisableRotate(pens: Pen[]): boolean {
  return pens.every((pen) => pen.disableRotate);
}

/**
 * 画笔们的 disableSize = true
 * 即 全部不允许改变大小 返回 true
 * @param pens 画笔
 * @returns
 */
export function getPensDisableResize(pens: Pen[]): boolean {
  return pens.every((pen) => pen.disableSize);
}

export function getFrameValue(pen: Pen, prop: string, frameIndex: number) {
  if (!pen.frames || !prop) {
    return 0;
  }

  let v = 0;
  for (let i = 0; i < frameIndex; i++) {
    if (pen.frames[i]) {
      v += pen.frames[i][prop] || 0;
    }
  }

  return v;
}

/**
 * 判断该画笔 是否是组合为状态中 展示的画笔
 */
export function isShowChild(pen: Pen, store: TopologyStore) {
  let selfPen = pen;
  while (selfPen.parentId) {
    const oldPen = selfPen;
    selfPen = store.pens[selfPen.parentId];
    const showChildIndex = selfPen?.calculative?.showChild;
    if (showChildIndex != undefined) {
      const showChildId = selfPen.children[showChildIndex];
      if (showChildId !== oldPen.id) {
        // toPng 不展示它
        return false;
      }
    }
  }
  return true;
}

/**
 * 计算画笔的 inView
 * @param pen 画笔
 * @param calcChild 是否计算子画笔
 */
export function calcInView(pen: Pen, calcChild = false) {
  const { store, canvasRect } = pen.calculative.canvas as Canvas;
  if (calcChild) {
    pen.children?.forEach((id) => {
      const child = store.pens[id];
      child && calcInView(child, true);
    });
  }

  pen.calculative.inView = true;
  if (!isShowChild(pen, store) || pen.visible == false || pen.calculative.visible == false) {
    pen.calculative.inView = false;
  } else {
    const { x, y, width, height, rotate } = pen.calculative.worldRect;
    const penRect: Rect = {
      x: x + store.data.x,
      y: y + store.data.y,
      width,
      height,
      rotate,
    };
    calcExy(penRect);
    if (!rectInRect(penRect, canvasRect)) {
      pen.calculative.inView = false;
    }
  }
  // TODO: 语义化上，用 onValue 更合适，但 onValue 会触发 echarts 图形的重绘，没有必要
  // 更改 view 后，修改 dom 节点的显示隐藏
  pen.onMove?.(pen);
}

/**
 * 绘制 rect ，上线后可查看 rect 位置
 */
function inspectRect(ctx: CanvasRenderingContext2D, store: TopologyStore, pen: Pen) {
  if (store.fillWorldTextRect) {
    ctx.save();
    ctx.fillStyle = '#c3deb7';
    const { x, y, width, height } = pen.calculative.worldTextRect;
    ctx.fillRect(x, y, width, height);
    ctx.restore();
  }
}

export function setGlobalAlpha(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, pen: Pen) {
  const globalAlpha = pen.calculative.globalAlpha;
  if (globalAlpha < 1) {
    ctx.globalAlpha = globalAlpha;
  }
}

/**
 * ctx 绘制图纸，并非 Path2D
 * @param ctx 画布上下文
 * @param pen 画笔
 */
function ctxDrawCanvas(ctx: CanvasRenderingContext2D, pen: Pen) {
  const canvasDraw = globalStore.canvasDraws[pen.name];
  if (canvasDraw) {
    // TODO: 后续考虑优化 save / restore
    ctx.save();
    // TODO: 原有 return 终止后续操作，必要性不大
    canvasDraw(ctx, pen);
    ctx.restore();
  }
}
