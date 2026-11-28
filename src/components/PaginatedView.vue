<template>
  <!-- 鼠标 / 触屏手势层：左右各 30% 翻页，中间 40% 切换工具栏
       z-30 必须高于翻页舞台激活层的 z-20，否则指针事件会被图片层吃掉 -->
  <div
    ref="gestureEl"
    class="reader-gesture-layer absolute inset-0 z-30 select-none"
    @click.stop.prevent="onClick"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @lostpointercapture="onPointerCancel"
    @contextmenu.prevent
  ></div>

  <!-- Hardware-Accelerated Double-Buffer Stage -->
  <div ref="pageStage" data-reader-stage @click="onContentLink" class="relative w-full h-full overflow-hidden">
    <div
      v-for="slot in [0, 1]"
      :key="slot"
      :ref="el => { if (el) stageEls[slot] = el as HTMLElement; }"
      class="stage-buffer-layer"
      :class="slot === 0 ? 'z-20' : 'z-10 pointer-events-none'"
      :style="slot === 0 ? 'opacity: 1; transform: translate3d(0,0,0);' : 'opacity: 0; transform: translate3d(0,0,0);'"
    >
      <!-- Manga: 1P Single -->
      <template v-if="isManga">
        <div class="w-full h-full items-center justify-center overflow-hidden" :class="slotVMs[slot] && slotVMs[slot].mode === 'single' ? 'flex' : 'hidden'">
          <img :ref="el => { if (el) imgEls[slot].single = el as HTMLImageElement; }" class="manga-page-img h-full w-auto max-w-full object-contain select-none" />
        </div>
        <!-- Manga: 2P Double -->
        <div class="w-full h-full items-center justify-center overflow-hidden" :class="slotVMs[slot] && slotVMs[slot].mode === 'double' ? 'flex' : 'hidden'">
          <div class="flex items-center justify-center w-full h-full relative">
            <div class="w-1/2 h-full flex items-center justify-end overflow-hidden">
              <img :ref="el => { if (el) imgEls[slot].left = el as HTMLImageElement; }" class="manga-page-img h-full max-h-full w-auto max-w-full object-contain object-right select-none" />
            </div>
            <div class="w-2 h-full book-spine-shadow pointer-events-none z-10 shrink-0"></div>
            <div class="w-1/2 h-full flex items-center justify-start overflow-hidden">
              <img :ref="el => { if (el) imgEls[slot].right = el as HTMLImageElement; }" class="manga-page-img h-full max-h-full w-auto max-w-full object-contain object-left select-none" />
            </div>
          </div>
        </div>
      </template>

      <!-- Novel: 纸面排版（单页 / 双页共用同一套几何，变量由舞台下发） -->
      <template v-else>
        <div class="reader-spread" :class="{ 'is-single': slotVMs[slot] && slotVMs[slot].mode === 'single' }">
          <template v-if="slotVMs[slot] && slotVMs[slot].mode === 'double'">
            <NovelCard :page="slotVMs[slot].left!" />
            <NovelCard :page="slotVMs[slot].right!" />
          </template>
          <NovelCard
            v-else-if="slotVMs[slot] && slotVMs[slot].single"
            :page="slotVMs[slot].single!"
          />
        </div>
      </template>
    </div>

    <ReaderFooter />
  </div>
</template>

<script setup lang="ts">
/* ============================================================================
   HOMURA · 双缓冲翻页引擎（原 renderer.js 的 Vue 化）
   ----------------------------------------------------------------------------
   两个 buffer 槽位交替上屏：先在离屏槽位填充内容并解码图片，再用 Web
   Animations API 在合成器线程跑翻页动画，动画结束后才后台预解码后续页。
   buffer 槽位的显隐 / z-index / transform 全部直操作 ref DOM，不经响应式，
   避免 Vue 重渲染打断进行中的动画。
   ========================================================================== */

import { shallowRef, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useReaderStore } from '../stores/reader.ts';
import { useThemeStore } from '../stores/theme.ts';
import { useUiStore } from '../stores/ui.ts';
import { useViewport } from '../composables/useViewport.ts';
import { isAndroid } from '../services/platform.ts';
import { ensurePageUrlLoaded, decodePageImage, releaseDistantPageUrls, type MangaPageItem } from '../services/pagination.ts';
import { resolveProseStyle, resolveReaderMetrics, resolveReaderFolios, type ReaderFolio } from '../services/readerLayout.ts';
import { epubLinkAtPoint } from '../services/epubLinks.ts';
import { classifyReaderGesture } from '../services/readerGestures.ts';
import { logRuntimeOperation } from '../services/runtimeLogs.ts';
import { createPageTurn, type PageTurnController } from '../services/pageTurn.ts';
import { pageTurnTarget, shouldCommitCoverSlide, type TurnSide } from '../services/pageTurnGeometry.ts';
import { prefersReducedMotion } from '../services/spring.ts';
import { decodeVisibleReaderImages, standaloneCover } from '../services/readerTransition.ts';
import NovelCard from './NovelCard.vue';
import ReaderFooter from './ReaderFooter.vue';
import type { Book, ReaderPage } from '../types.ts';

interface SlotVM {
  mode: 'single' | 'double';
  folios: ReaderFolio[];
  single?: ReaderPage;
  left?: ReaderPage;
  right?: ReaderPage;
  singleLabel?: string;
  leftLabel?: string;
  rightLabel?: string;
  total: number;
}

const props = defineProps({ opening: Boolean });
const emit = defineEmits<{ 'first-frame': [book: Book, ready: boolean, cover?: HTMLImageElement | null] }>();
const reader = useReaderStore();
const theme = useThemeStore();
const ui = useUiStore();
const { isCompact } = useViewport();
const gestureEl = shallowRef<HTMLElement | null>(null);
const pageStage = shallowRef<HTMLElement | null>(null);
let stageResizeObserver: ResizeObserver | null = null;

const isManga = computed(() => reader.currentBook && reader.currentBook.type === 'manga');

// 纸面几何：变量挂在舞台上，两个 buffer 槽位与纸页共同继承。
// 不经过响应式 :style 绑定，避免翻页动画进行中被重渲染改写 transform。
function applyReaderGeometry() {
  const el = pageStage.value;
  if (!el || isManga.value) return;
  const metrics = resolveReaderMetrics({
    width: el.clientWidth,
    height: el.clientHeight,
    layout: reader.layoutConfig,
    compact: isCompact.value
  });
  el.style.setProperty('--reader-pad-x', metrics.padX + 'px');
  el.style.setProperty('--reader-pad-top', metrics.padTop + 'px');
  el.style.setProperty('--reader-pad-bottom', metrics.padBottom + 'px');
  el.style.setProperty('--reader-gutter', metrics.gutter + 'px');
  el.style.setProperty('--reader-page-width', metrics.textWidth + 'px');
  el.style.setProperty('--reader-flow-height', metrics.textHeight + 'px');
  // 双页几何下的单页（章首页 / 封面单排）靠 CSS 占位补出另一栏，保持与苹果图书一致的右栏起始
  el.dataset.readerSpread = metrics.isDouble ? 'double' : 'single';
  el.dataset.readerDirection = reader.layoutConfig.direction;
  const proseStyle = resolveProseStyle(reader.layoutConfig);
  for (const [name, value] of Object.entries(proseStyle)) el.style.setProperty(name, value);
}

// 每个槽位的视图模型：single / double 模式 + 页面 + 阅读顺序标签
const slotVMs = shallowRef<(SlotVM | null)[]>([null, null]);

// 直操作 DOM 引用：stage 层与 manga img（不挂响应式）
const stageEls: (HTMLElement | null)[] = [null, null];
const imgEls: { single: HTMLImageElement | null; left: HTMLImageElement | null; right: HTMLImageElement | null }[] = [{ single: null, left: null, right: null }, { single: null, left: null, right: null }];

// 组件按 书 id+type key 重挂载，首次渲染只填槽位 0、无动画
let initialized = false;
let preloadGeneration = 0;
let displayedIndex = 0;
let pendingRender = 0;
let previewGeneration = 0;
let activePaperTurn: PageTurnController | null = null;
let finishBufferFade: (() => void) | null = null;
let bufferQueue: Promise<unknown> = Promise.resolve();
let turnOriginY: number | null = null;
// 覆盖滑动依次处理已接收的落点，卷页仍合并到最后一次请求。
let renderRunId = 0;
let renderBusy = false;
const queuedTurns: { direction: string; index: number }[] = [];
let settlingCover = false;
const coverEnabled = () => theme.transitionStyle === 'slide' && !prefersReducedMotion();
const mobileCover = () => isCompact.value || isAndroid;
const coverClass = (active: boolean) => pageStage.value?.parentElement?.classList.toggle('is-cover-turning', active);
interface GesturePreview {
  targetIndex: number;
  nextSlot: number;
  forward: boolean;
  dx: number;
  dy: number;
  ready: Promise<boolean>;
  velocity: number;
  controller: PageTurnController | null;
}
let gesturePreview: GesturePreview | null = null;

// 槽位切换后清掉不再使用的 img.src，释放上一页的位图。
// 两个槽位共用同一组 img 节点，隐藏模式里的旧图会一直占内存。
function clearSlotImages(slotIndex: number, keepKeys: string[]) {
  const refs = imgEls[slotIndex];
  for (const key of ['single', 'left', 'right'] as const) {
    const el = refs[key];
    if (!el || keepKeys.includes(key) || !el.getAttribute('src')) continue;
    el.removeAttribute('src');
    el.setAttribute('data-current-src', '');
  }
}

function buildSlotVM(pair: ReaderPage[], total: number): SlotVM {
  const rtl = reader.layoutConfig.direction === 'rtl';
  const folios = resolveReaderFolios(pair, {
    rtl,
    singleOnRight: reader.effectiveDouble && !isManga.value,
    startIndex: Math.max(0, reader.activePages.indexOf(pair[0]!))
  });
  if (pair.length === 1) {
    return {
      mode: 'single',
      folios,
      single: pair[0],
      singleLabel: rtl ? '[右→左]' : '[左→右]',
      total
    };
  }
  const left = rtl ? pair[1] : pair[0];
  const right = rtl ? pair[0] : pair[1];
  return {
    mode: 'double',
    folios,
    left,
    right,
    leftLabel: rtl ? '左页(后读)' : '左页(先读)',
    rightLabel: rtl ? '右页(先读)' : '右页(后读)',
    total
  };
}

// Populate a target buffer slot (0 or 1) and decode its images BEFORE starting the transition
async function populateBufferSlot(slotIndex: number, pair: ReaderPage[], total: number, valid: () => boolean) {
  if (isManga.value) {
    for (const p of pair) {
      await ensurePageUrlLoaded(p.itemRef as MangaPageItem);
    }
  }
  if (!valid()) return false;
  const vm = buildSlotVM(pair, total);
  const next = slotVMs.value.slice();
  next[slotIndex] = vm;
  slotVMs.value = next;
  // 等 Vue 把槽位内容（包装显隐 / 小说 v-html）patch 进 DOM 后再解码或开启动画
  await nextTick();
  if (!valid()) return false;
  clearSlotImages(slotIndex, vm.mode === 'single' ? ['single'] : ['left', 'right']);

  if (!isManga.value) return true;
  const images = imgEls[slotIndex];
  const decode = async (image: HTMLImageElement, page: ReaderPage) => {
    const decoded = await decodePageImage(image, page.itemRef as MangaPageItem, { requireDecode: props.opening });
    return decoded && image.naturalWidth > 0;
  };
  if (vm.mode === 'single') return decode(images.single!, vm.single!);
  const decoded = await Promise.all([decode(images.left!, vm.left!), decode(images.right!, vm.right!)]);
  return decoded.every(Boolean);
}

// 解码与 Vue patch 串行进入同一备用槽，旧请求不能在新请求完成后改写 img.src。
function prepareSlot(slot: number, pair: ReaderPage[], total: number, valid: () => boolean, requireImages = false) {
  const task = bufferQueue.then(async () => {
    if (!valid()) return false;
    const decoded = await populateBufferSlot(slot, pair, total, valid);
    return valid() && (!requireImages || decoded);
  });
  bufferQueue = task.catch(() => {});
  return task;
}

function showSlot(slot: number) {
  stageEls.forEach((element, index) => {
    if (!element) return;
    element.classList.remove('is-cover-loading');
    element.style.opacity = index === slot ? '1' : '0';
    element.style.transform = 'translate3d(0,0,0)';
    element.style.zIndex = index === slot ? '20' : '10';
    element.classList.toggle('pointer-events-none', index !== slot);
  });
}

function cancelBufferAnimations() {
  // 先同步落到已提交的目标页，避免旧动画的异步 cancel 回调改写复用后的槽位。
  finishBufferFade?.();
  reader.activeTransitionAnims.forEach(animation => { try { animation.cancel(); } catch {} });
  reader.activeTransitionAnims = [];
}

function fadeBuffer(outgoing: HTMLElement, incoming: HTMLElement, slot: number) {
  // 两槽都有不透明纸色；旧页保持完整，新页覆盖淡入，整段转场不会露出空白底。
  outgoing.style.opacity = '1';
  const animation = incoming.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: 200,
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)'
  });
  reader.activeTransitionAnims = [animation];
  return new Promise<void>(resolve => {
    const finish = () => {
      if (finishBufferFade !== finish) return;
      finishBufferFade = null;
      animation.onfinish = null;
      animation.oncancel = null;
      showSlot(slot);
      reader.activeTransitionAnims = [];
      animation.cancel();
      resolve();
    };
    finishBufferFade = finish;
    animation.onfinish = finish;
    animation.oncancel = finish;
  });
}

function stopPaperTurn() {
  cancelBufferAnimations();
  previewGeneration++;
  gesturePreview = null;
  activePaperTurn?.destroy();
  activePaperTurn = null;
  settlingCover = false;
  coverClass(false);
  showSlot(reader.activeBufferSlot);
}

function finishPaperTurn(controller: PageTurnController, slot: number) {
  if (activePaperTurn !== controller) return;
  controller.destroy();
  activePaperTurn = null;
  settlingCover = false;
  coverClass(false);
  showSlot(slot);
}

function paperTurnPageNumbers(outgoingSlot: number, incomingSlot: number, targetPair?: ReaderPage[]) {
  const label = pageStage.value?.querySelector<HTMLElement>('.md-reader-footer-pages');
  const outgoing = slotVMs.value[outgoingSlot]?.folios;
  const incoming = targetPair ? buildSlotVM(targetPair, reader.activePages.length).folios : slotVMs.value[incomingSlot]?.folios;
  if (!label || !outgoing?.length || !incoming?.length) return undefined;
  return { label, outgoing, incoming, total: reader.activePages.length, showTotal: label.dataset.pageCountVisible === 'true' };
}

async function renderReaderViewport(transitionDir: string, targetIndex: number) {
  const book = reader.currentBook;
  if (!book) return;
  const myToken = ++reader.renderToken;
  const forward = targetIndex > displayedIndex;
  const preview = gesturePreview?.targetIndex === targetIndex ? gesturePreview : null;
  const originY = turnOriginY ?? 0;
  turnOriginY = null;
  pendingRender = myToken;
  cancelIdlePreload();
  if (!preview) {
    endPointer();
    stopPaperTurn();
    if (isDirectionalTurn(transitionDir) && coverEnabled()) coverClass(true);
  }
  const valid = () => myToken === reader.renderToken && reader.currentBook === book;
  const total = reader.activePages.length;
  const pair = reader.getSpreadPair(targetIndex);
  if (targetIndex === reader.currentIndex) {
    reader.sliderValue = targetIndex;
    reader.touchProgress();
    reader.pageIndicator = `${pair.map(p => p.pageNumber).join('-')} / ${total}`;
  }
  try {
    if (!initialized) {
      const ready = await prepareSlot(0, pair, total, valid, props.opening);
      const slot = stageEls[0];
      if (ready && props.opening && !isManga.value && slot && pageStage.value) {
        await decodeVisibleReaderImages(slot, pageStage.value);
      }
      if (!valid()) return;
      if (!ready) {
        emit('first-frame', book, false);
        return;
      }
      initialized = true;
      displayedIndex = targetIndex;
      reader.activeBufferSlot = 0;
      showSlot(0);
      const cover = targetIndex === 0 && pair.length === 1
        ? isManga.value ? imgEls[0].single : standaloneCover(slot?.querySelector('.reader-page-flow') ?? null)
        : null;
      emit('first-frame', book, true, cover);
      scheduleIdlePreload();
      return;
    }
    const prevSlot = reader.activeBufferSlot;
    const nextSlot = preview?.nextSlot ?? 1 - prevSlot;
    let controller: PageTurnController | null = null;
    if (preview) {
      if (await preview.ready) controller = preview.controller;
      if (!valid()) return;
      gesturePreview = null;
    }
    if (!controller && !await prepareSlot(nextSlot, pair, total, valid)) return;
    if (!valid()) return;
    reader.activeBufferSlot = nextSlot;
    displayedIndex = targetIndex;
    pendingRender = 0;
    if (isManga.value) releaseDistantPageUrls(book, targetIndex, isAndroid ? 3 : 5);
    const outEl = stageEls[prevSlot]!;
    const inEl = stageEls[nextSlot]!;
    const style = theme.transitionStyle;
    if (!controller && isDirectionalTurn(transitionDir) && (style === 'slide' || style === 'curl') && !prefersReducedMotion()) {
      controller = createPageTurn({ stage: pageStage.value!, outgoing: outEl, incoming: inEl, style, forward, side: reader.layoutConfig.direction === 'rtl' ? -1 : 1, originY, compact: isCompact.value, lowPower: isAndroid, pageNumbers: paperTurnPageNumbers(prevSlot, nextSlot) });
      activePaperTurn = controller;
    }
    if (controller) {
      settlingCover = style === 'slide';
      const finished = controller.finish(true, preview?.velocity);
      if (settlingCover && queuedTurns.length) flushQueuedTurn();
      const completed = await finished;
      if (!completed || !valid()) return;
      finishPaperTurn(controller, nextSlot);
    } else {
      showSlot(nextSlot);
      if (style !== 'none' && transitionDir !== 'none' && !prefersReducedMotion() && typeof inEl.animate === 'function') {
        await fadeBuffer(outEl, inEl, nextSlot);
        if (!valid()) return;
      }
    }
    if (!drag.active) scheduleIdlePreload();
  } catch (error) {
    if (!valid()) return;
    console.warn('翻页准备失败', error);
    stopPaperTurn();
    if (!initialized) emit('first-frame', book, false);
  } finally {
    if (pendingRender === myToken) {
      pendingRender = 0;
      if (!activePaperTurn) coverClass(false);
    }
  }
}

function isDirectionalTurn(transitionDir: string) {
  return transitionDir === 'enter-from-right' || transitionDir === 'enter-from-left';
}

function clearQueuedTurn() {
  queuedTurns.length = 0;
}

async function runReaderRender(direction: string, index = reader.currentIndex) {
  const runId = ++renderRunId;
  renderBusy = true;
  try {
    await renderReaderViewport(direction, index);
  } finally {
    if (runId === renderRunId) {
      renderBusy = false;
      flushQueuedTurn();
    }
  }
}

function flushQueuedTurn() {
  if (!queuedTurns.length || !reader.currentBook || (renderBusy && !settlingCover)) return;
  const turn = queuedTurns.shift()!;
  void runReaderRender(turn.direction, turn.index);
}

function requestReaderRender(direction: string) {
  if (!reader.currentBook) return;
  // 跳章、重排和滑条定位会废弃之前请求的落点。
  if (!isDirectionalTurn(direction)) {
    clearQueuedTurn();
    void runReaderRender(direction);
    return;
  }
  if (!coverEnabled()) clearQueuedTurn();
  queuedTurns.push({ direction, index: reader.currentIndex });
  flushQueuedTurn();
}

function prepareGestureTurn() {
  const style = drag.style;
  if (style !== 'slide' && style !== 'curl') return false;
  const forward = drag.dx === 0 && gesturePreview
    ? gesturePreview.forward
    : (drag.dx < 0) !== reader.isNavigationInverted();
  if (gesturePreview?.forward === forward) {
    gesturePreview.dx = drag.dx;
    gesturePreview.dy = drag.dy;
    gesturePreview.controller?.move(drag.dx, drag.dy);
    return true;
  }
  const direction = forward ? 'forward' : 'backward';
  if (dragTargets[direction] === undefined) {
    const step = forward ? reader.getStepSizeForNext() : reader.getStepSizeForPrev();
    dragTargets[direction] = pageTurnTarget(reader.currentIndex, reader.activePages.length, step, forward);
  }
  const targetIndex = dragTargets[direction];
  if (targetIndex === null) return false;
  stopPaperTurn();
  cancelIdlePreload();
  const generation = ++previewGeneration;
  const bookId = reader.currentBook?.id;
  const nextSlot = 1 - reader.activeBufferSlot;
  const side: TurnSide = forward ? (drag.dx < 0 ? 1 : -1) : (drag.dx > 0 ? 1 : -1);
  const bounds = drag.bounds!;
  const y = drag.startY - bounds.top;
  const originY = y < bounds.height * 0.28 ? 0 : y > bounds.height * 0.72 ? bounds.height : y;
  const preview: GesturePreview = { targetIndex, nextSlot, forward, dx: drag.dx, dy: drag.dy, ready: Promise.resolve(false), velocity: 0, controller: null };
  gesturePreview = preview;
  const valid = () => gesturePreview === preview && generation === previewGeneration && reader.currentBook?.id === bookId;
  const pair = reader.getSpreadPair(targetIndex);
  const createController = (pendingContent: boolean) => {
    resetStageTransform();
    const incoming = stageEls[nextSlot]!;
    incoming.classList.toggle('is-cover-loading', pendingContent);
    const controller = createPageTurn({ stage: pageStage.value!, outgoing: activeStageEl()!, incoming, style, forward, side, originY, compact: isCompact.value, lowPower: isAndroid, pageNumbers: paperTurnPageNumbers(reader.activeBufferSlot, nextSlot, pendingContent ? pair : undefined) });
    activePaperTurn = controller;
    preview.controller = controller;
    controller.move(preview.dx, preview.dy);
  };
  if (style === 'slide') {
    createController(true);
    coverClass(true);
  }
  preview.ready = prepareSlot(nextSlot, pair, reader.activePages.length, valid).then(ready => {
    if (!ready) return false;
    if (style === 'slide') stageEls[nextSlot]?.classList.remove('is-cover-loading');
    else createController(false);
    return true;
  }).catch(error => {
    if (valid()) { console.warn('跟手翻页准备失败', error); stopPaperTurn(); }
    return false;
  });
  return true;
}

function cancelGestureTurn(velocity = 0) {
  const controller = gesturePreview?.controller;
  previewGeneration++;
  gesturePreview = null;
  if (controller) {
    void controller.finish(false, velocity).then(completed => {
      if (completed) { finishPaperTurn(controller, reader.activeBufferSlot); scheduleIdlePreload(); }
    });
  } else {
    resetStageTransform();
    scheduleIdlePreload();
  }
}

// Background Preloader: Only runs AFTER page turn animation completes so animation never drops a frame!
function cancelIdlePreload() {
  preloadGeneration++;
  clearTimeout(reader.preloadTimer ?? undefined);
  reader.preloadTimer = null;
}

function scheduleIdlePreload() {
  cancelIdlePreload();
  if (props.opening || !reader.currentBook || reader.currentBook.type !== 'manga') return;

  const generation = preloadGeneration;
  const startIndex = reader.currentIndex;
  // 安卓机减少预载数量和并发解码压力；一次翻页只提前准备两页。
  const pagesAhead = isAndroid ? 2 : 4;
  const delay = isAndroid ? 420 : 280;

  reader.preloadTimer = window.setTimeout(async () => {
    if (generation !== preloadGeneration || reader.currentIndex !== startIndex) return;
    for (let i = 1; i <= pagesAhead; i++) {
      if (generation !== preloadGeneration) return;
      if (document.visibilityState === 'hidden') return;
      if (reader.currentIndex !== startIndex) return;
      const nextPage = reader.activePages[startIndex + i];
      if (nextPage && nextPage.itemRef && !(nextPage.itemRef as { url?: string }).url) {
        const url = await ensurePageUrlLoaded(nextPage.itemRef as MangaPageItem);
        if (generation !== preloadGeneration || reader.currentIndex !== startIndex) return;
        if (url) {
          const img = new Image();
          img.decoding = 'async';
          img.src = url;
          if (img.decode) {
            try { await img.decode(); } catch (e) {}
          }
        }
      }
    }
  }, delay);
}

watch(() => props.opening, opening => {
  if (!opening && initialized) scheduleIdlePreload();
});

// ---- 统一指针手势：移动越过阈值后，即使回到原位也不再当成点击 ----
const drag: {
  active: boolean;
  pointerId: number | null;
  startX: number;
  startY: number;
  startTime: number;
  dx: number;
  dy: number;
  axis: 'x' | 'y' | null;
  maxDistance: number;
  bounds: DOMRect | null;
  style: string;
  mobile: boolean;
} = {
  active: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  startTime: 0,
  dx: 0,
  dy: 0,
  axis: null,
  maxDistance: 0,
  bounds: null,
  style: 'none',
  mobile: false
};
const dragTargets: Partial<Record<'forward' | 'backward', number | null>> = {};
const pointerSamples: { x: number; time: number }[] = [];
let pressedLink: HTMLAnchorElement | null = null;
let lastPointerType: string | null = null;
let allowMouseClick = false;
let suppressMouseClick = false;

function activeStageEl() {
  return stageEls[reader.activeBufferSlot];
}

// 拖拽阻尼：前半段跟手，超出后明显变沉，避免整页被拖出屏幕
function dampedOffset(dx: number) {
  const limit = (window.innerWidth || 375) * 0.22;
  const sign = dx < 0 ? -1 : 1;
  const abs = Math.abs(dx);
  if (abs <= limit) return dx * 0.55;
  return sign * (limit * 0.55 + (abs - limit) * 0.12);
}

function resetStageTransform() {
  const el = activeStageEl();
  if (el) el.style.transform = 'translate3d(0, 0, 0)';
}

function isAndroidBoundaryDrag() {
  return isAndroid && drag.dx !== 0 && reader.isAtPagedBoundary((drag.dx < 0) !== reader.isNavigationInverted());
}

function turnFromCanvas(zone: 'left' | 'right', originY: number) {
  const index = reader.currentIndex;
  turnOriginY = originY;
  if (zone === 'left') reader.onLeftButtonClick();
  else reader.onRightButtonClick();
  if (isAndroid && reader.currentIndex === index) turnOriginY = null;
}

function onPointerDown(e: PointerEvent) {
  if (!reader.currentBook || reader.openingBook || pendingRender || ui.readerDrawerOpen || document.querySelector('dialog[open]')) return;
  if (e.isPrimary === false) { onPointerCancel(undefined); return; }
  if (drag.active || (e.pointerType === 'mouse' && e.button !== 0)) return;
  lastPointerType = e.pointerType;
  allowMouseClick = false;
  suppressMouseClick = false;
  stopPaperTurn();
  pressedLink = reader.currentBook?.format === 'epub' ? epubLinkAtPoint(activeStageEl(), e.clientX, e.clientY) : null;
  cancelIdlePreload();
  drag.active = true;
  drag.pointerId = e.pointerId;
  drag.startX = e.clientX;
  drag.startY = e.clientY;
  drag.startTime = Date.now();
  drag.bounds = gestureEl.value!.getBoundingClientRect();
  drag.style = prefersReducedMotion() ? 'none' : theme.transitionStyle;
  drag.mobile = mobileCover();
  dragTargets.forward = undefined;
  dragTargets.backward = undefined;
  pointerSamples.length = 0;
  samplePointer(e);
  drag.dx = 0;
  drag.dy = 0;
  drag.axis = null;
  drag.maxDistance = 0;
  if (gestureEl.value) {
    try { gestureEl.value.setPointerCapture(e.pointerId); } catch (err) {}
  }
}

function samplePointer(event: PointerEvent) {
  if (drag.style !== 'slide' || !drag.mobile) return;
  const coalesced = event.getCoalescedEvents?.() ?? [];
  for (const point of coalesced.length ? coalesced : [event]) {
    if (point.clientX !== pointerSamples[pointerSamples.length - 1]?.x) {
      pointerSamples.push({ x: point.clientX, time: point.timeStamp });
    }
  }
  const latest = pointerSamples[pointerSamples.length - 1];
  while (latest && (pointerSamples.length > 8 || latest.time - pointerSamples[0]!.time > 64)) {
    pointerSamples.shift();
  }
}

function pointerVelocity(event: PointerEvent) {
  const latest = pointerSamples[pointerSamples.length - 1];
  const oldest = pointerSamples[0];
  if (!latest || !oldest || latest === oldest || event.timeStamp - latest.time > 64) return 0;
  return (latest.x - oldest.x) / Math.max(8, latest.time - oldest.time);
}

function endPointer() {
  const id = drag.pointerId;
  drag.active = false;
  drag.pointerId = null;
  if (id !== null && gestureEl.value?.hasPointerCapture?.(id)) gestureEl.value.releasePointerCapture(id);
}

function onPointerMove(e: PointerEvent) {
  if (!drag.active || e.pointerId !== drag.pointerId) return;
  if (ui.readerDrawerOpen) { onPointerCancel(e); return; }
  samplePointer(e);
  drag.dx = e.clientX - drag.startX;
  drag.dy = e.clientY - drag.startY;
  const absX = Math.abs(drag.dx);
  const absY = Math.abs(drag.dy);
  drag.maxDistance = Math.max(drag.maxDistance, absX, absY);
  if (drag.style === 'slide') {
    if (!drag.axis && absX >= 7 && absX > absY) drag.axis = 'x';
  } else if (!drag.axis && (absX > 8 || absY > 8)) {
    drag.axis = absX >= absY ? 'x' : 'y';
  }
  // 手指起始方向常有竖向抖动：横向位移明显占优时改判为横向手势
  if (drag.axis === 'y' && absX > 16 && absX > absY * 1.4) {
    drag.axis = 'x';
  }
  if (drag.axis === 'x') {
    if (isAndroidBoundaryDrag()) {
      if (gesturePreview) stopPaperTurn();
      resetStageTransform();
      coverClass(false);
      return;
    }
    if (!prepareGestureTurn()) {
      if (gesturePreview) stopPaperTurn();
      if (drag.style === 'slide') coverClass(true);
      const el = activeStageEl();
      if (el) el.style.transform = `translate3d(${dampedOffset(drag.dx)}px, 0, 0)`;
    }
  }
}

function onPointerUp(e: PointerEvent) {
  if (!drag.active || e.pointerId !== drag.pointerId) return;
  onPointerMove(e);
  if (!drag.active) return;
  endPointer();

  const dx = drag.dx;
  const dy = drag.dy;
  const dt = Math.max(1, Date.now() - drag.startTime);
  const bounds = drag.bounds!;
  let result = classifyReaderGesture({ dx, dy, duration: dt, maxDistance: drag.maxDistance, width: bounds.width, x: e.clientX - bounds.left });
  const velocity = pointerVelocity(e);
  if (drag.style === 'slide' && drag.axis === 'x') {
    if (drag.mobile) {
      result = shouldCommitCoverSlide(dx, velocity, bounds.width)
        ? { type: 'swipe', zone: dx > 0 ? 'left' : 'right' }
        : { type: 'cancel', zone: null };
    } else if (result.type === 'tap') {
      result = { type: 'cancel', zone: null };
    }
  }
  const el = activeStageEl();

  if (result.type === 'swipe' || result.type === 'tap') {
    if (!gesturePreview?.controller) resetStageTransform();
    if (gesturePreview) gesturePreview.velocity = velocity;
    else coverClass(false);
    // 鼠标点击由原生 click 事件处理，避免 pointerup 的严格手势阈值吞掉普通点击。
    // 鼠标拖拽仍在这里翻页，并拦截浏览器随后合成的 click，防止重复翻页。
    if (e.pointerType === 'mouse' && result.type === 'tap') {
      allowMouseClick = true;
      return;
    }
    if (e.pointerType === 'mouse') suppressMouseClick = true;
    if (result.type === 'tap' && activateLink(e.clientX, e.clientY)) return;
    if (result.zone === 'left' || result.zone === 'right') {
      turnFromCanvas(result.zone, drag.startY - bounds.top);
    } else {
      turnOriginY = null;
      logRuntimeOperation('切换阅读工具栏');
      ui.toggleChrome();
    }
    return;
  }
  if (gesturePreview) {
    if (e.pointerType === 'mouse') suppressMouseClick = true;
    cancelGestureTurn(velocity);
    return;
  }
  // 长按未移动不翻页；拖动不足距离时回弹，且不补发点击。
  if (drag.axis === 'x' && dx && !isAndroidBoundaryDrag() && el && el.animate && !prefersReducedMotion()) {
    if (e.pointerType === 'mouse') suppressMouseClick = true;
    el.style.transform = 'translate3d(0, 0, 0)';
    const bounce = el.animate(
      [
        { transform: `translate3d(${dampedOffset(dx)}px, 0, 0)` },
        { transform: 'translate3d(0, 0, 0)' }
      ],
      { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
    );
    reader.activeTransitionAnims = [bounce];
    bounce.onfinish = () => {
      if (reader.activeTransitionAnims[0] === bounce) {
        reader.activeTransitionAnims = [];
        coverClass(false);
      }
    };
  } else {
    if (e.pointerType === 'mouse') suppressMouseClick = true;
    resetStageTransform();
    coverClass(false);
  }
}

function onContentLink(event: MouseEvent) {
  const link = (event.target as Element)?.closest<HTMLAnchorElement>('a[href]');
  if (!link) return;
  event.preventDefault();
  event.stopPropagation();
  if (reader.currentBook?.format !== 'epub') return;
  const chapterIndex = Number(link.closest('[data-chapter-index]')?.getAttribute('data-chapter-index'));
  reader.followEpubLink(link.getAttribute('href') || '', chapterIndex);
}

function activateLink(x: number, y: number) {
  const link = pressedLink;
  pressedLink = null;
  if (!link || link !== epubLinkAtPoint(activeStageEl(), x, y)) return false;
  const chapterIndex = Number(link.closest('[data-chapter-index]')?.getAttribute('data-chapter-index'));
  reader.followEpubLink(link.getAttribute('href') || '', chapterIndex);
  return true;
}

function onClick(e: MouseEvent) {
  if (suppressMouseClick) {
    suppressMouseClick = false;
    allowMouseClick = false;
    lastPointerType = null;
    return;
  }
  if (lastPointerType !== 'mouse' || !allowMouseClick || e.detail === 0 || !reader.currentBook || reader.openingBook || ui.readerDrawerOpen) return;
  allowMouseClick = false;
  lastPointerType = null;
  if (activateLink(e.clientX, e.clientY)) return;
  const bounds = gestureEl.value?.getBoundingClientRect();
  if (!bounds || bounds.width <= 0) return;
  const zone = classifyReaderGesture({ dx: 0, dy: 0, duration: 0, width: bounds.width, x: e.clientX - bounds.left }).zone;
  if (zone === 'left' || zone === 'right') {
    turnFromCanvas(zone, e.clientY - bounds.top);
  } else {
    turnOriginY = null;
    logRuntimeOperation('切换阅读工具栏');
    ui.toggleChrome();
  }
}

function onPointerCancel(event?: PointerEvent) {
  if (event?.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
  if (!drag.active) return;
  endPointer();
  allowMouseClick = false;
  suppressMouseClick = true;
  if (gesturePreview) cancelGestureTurn();
  else { resetStageTransform(); coverClass(false); }
}

onMounted(() => {
  stageResizeObserver = new ResizeObserver(() => {
    onPointerCancel();
    stopPaperTurn();
    applyReaderGeometry();
    if (!isManga.value) reader.handleViewportChange();
  });
  if (pageStage.value) stageResizeObserver!.observe(pageStage.value);
  window.addEventListener('blur', onPointerCancel as EventListener);
  reader.renderFn = requestReaderRender;
  watch(
    () => [
      reader.layoutConfig.spread,
      reader.layoutConfig.pageMargin,
      reader.layoutConfig.fontSize,
      reader.layoutConfig.fontFamily,
      reader.layoutConfig.lineHeight,
      reader.layoutConfig.verticalText,
      isCompact.value
    ],
    applyReaderGeometry
  );
  watch(() => [theme.transitionStyle, reader.layoutConfig.direction, reader.layoutConfig.spread, ui.readerDrawerOpen], () => {
    onPointerCancel();
    stopPaperTurn();
  });
  applyReaderGeometry();
  // store 动作可能在组件挂载前就已完成分页，这里自检后直接首渲染
  if (reader.activePages.length > 0) {
    void runReaderRender('none');
  }
});

onBeforeUnmount(() => {
  reader.renderToken++;
  renderRunId++;
  renderBusy = false;
  clearQueuedTurn();
  pendingRender = 0;
  endPointer();
  stopPaperTurn();
  cancelIdlePreload();
  stageResizeObserver?.disconnect();
  window.removeEventListener('blur', onPointerCancel as EventListener);
  reader.renderFn = null;
  cancelBufferAnimations();
  const el = activeStageEl();
  if (el) el.style.transform = 'translate3d(0, 0, 0)';
});
</script>
