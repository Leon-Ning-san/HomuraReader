/* ============================================================================
   HOMURA · 阅读器快捷键与窗口事件
   ----------------------------------------------------------------------------
   键盘（方向键 / 空格 / Esc）、视口滚轮翻页、
   窗口尺寸变化时的小说重排。Android 返回手势由 useReaderBackDismiss 接管。
   ========================================================================== */

import { onMounted, onBeforeUnmount, watch, type Ref } from 'vue';
import { useUiStore } from '../stores/ui.ts';
import type { useReaderStore } from '../stores/reader.ts';

type ReaderStore = ReturnType<typeof useReaderStore>;
const COVER_WHEEL_IDLE_GAP = 140;

export function useShortcuts(
  reader: ReaderStore, viewportRef: Ref<HTMLElement | null>, dismissWithPredictiveBack: () => void,
  opening: () => boolean, cancelOpening: () => void, coverSlide: () => boolean
) {
  const ui = useUiStore();

  function onKeydown(e: KeyboardEvent) {
    if (opening()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelOpening();
      }
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

    if (!reader.currentBook) return;
    if (ui.readerDrawerOpen && e.key !== 'Escape') return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      reader.onLeftButtonClick();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      reader.onRightButtonClick();
    } else if (e.key === 'ArrowDown' || e.key === ' ') {
      e.preventDefault();
      reader.goNextPage();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      reader.goPrevPage();
    } else if (e.key === 'Escape') {
      // 逐层退出：先关抽屉，再唤出工具栏，最后关闭阅读器
      if (ui.fontMenuOpen) {
        ui.closeFontMenu();
      } else if (ui.settingsOpen) {
        ui.closeSettings();
      } else if (ui.tocOpen) {
        ui.closeToc();
      } else if (!ui.readerChromeVisible) {
        ui.showChrome();
      } else {
        dismissWithPredictiveBack();
      }
    }
  }

  let wheelGesture: { axis: 'x' | 'y'; time: number; distance: number; direction: number } | null = null;

  function onCoverWheel(event: WheelEvent) {
    const discrete = event.deltaMode !== 0;
    const dominantAxis = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? 'x' : 'y';
    if (!event.deltaX && !event.deltaY) return;
    if (discrete) {
      wheelGesture = null;
    } else if (!wheelGesture || event.timeStamp - wheelGesture.time >= COVER_WHEEL_IDLE_GAP
      || (!wheelGesture.direction && wheelGesture.axis !== dominantAxis)) {
      wheelGesture = { axis: dominantAxis, time: event.timeStamp, distance: 0, direction: 0 };
    }

    const axis = wheelGesture?.axis ?? dominantAxis;
    const delta = axis === 'x' ? event.deltaX : event.deltaY;
    if (wheelGesture) wheelGesture.time = event.timeStamp;
    if (!delta) return;

    if (wheelGesture) {
      const direction = Math.sign(delta);
      // 同一像素滚动序列的惯性尾段继续更新时间，只在明确反拨时重新翻页。
      if (wheelGesture.direction === direction) {
        wheelGesture.distance = 0;
        return;
      }
      if (wheelGesture.distance * delta < 0) wheelGesture.distance = 0;
      wheelGesture.distance += delta;
      if (Math.abs(wheelGesture.distance) < (axis === 'x' ? 48 : 24)) return;
      wheelGesture.direction = direction;
      wheelGesture.distance = 0;
    }

    if (axis === 'x') {
      if (delta > 0) reader.onRightButtonClick();
      else reader.onLeftButtonClick();
    } else if (delta > 0) reader.goNextPage();
    else reader.goPrevPage();
  }

  watch(() => [reader.currentBook?.id, opening(), ui.readerDrawerOpen, coverSlide()], () => {
    wheelGesture = null;
  });

  // Mouse Wheel Page Turn Support（条漫模式让位原生滚动）
  function onWheel(e: WheelEvent) {
    if (!reader.currentBook || opening() || e.ctrlKey) return;
    // 抽屉打开时滚轮属于抽屉内容，不能截成阅读器翻页
    if (ui.readerDrawerOpen) return;
    if (reader.layoutConfig.direction === 'vertical') return;

    e.preventDefault();
    if (coverSlide()) { onCoverWheel(e); return; }
    const now = Date.now();
    if (now - reader.lastWheelTurnTime < 190) return;

    if (Math.abs(e.deltaY) > 10) {
      reader.lastWheelTurnTime = now;
      if (e.deltaY > 0) {
        reader.goNextPage();
      } else {
        reader.goPrevPage();
      }
    } else if (Math.abs(e.deltaX) > 15) {
      reader.lastWheelTurnTime = now;
      if (e.deltaX > 0) {
        reader.onRightButtonClick();
      } else {
        reader.onLeftButtonClick();
      }
    }
  }

  // 窗口尺寸变化：交给 store 判断是重排小说还是单双页档位变化后重渲染
  function onResize() {
    if (!reader.currentBook) return;
    reader.handleViewportChange();
  }

  // 移动端地址栏伸缩只触发 visualViewport resize 且抖动频繁：
  // 高度变化超过 80px 才视为真正的视口变化，避免阅读中反复重排
  let lastViewportHeight = 0;
  function onVisualViewportResize() {
    const h = window.visualViewport ? window.visualViewport.height : 0;
    if (!h) return;
    if (Math.abs(h - lastViewportHeight) < 80) return;
    lastViewportHeight = h;
    onResize();
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', onResize);
    if (window.visualViewport) {
      lastViewportHeight = window.visualViewport.height;
      window.visualViewport.addEventListener('resize', onVisualViewportResize);
    }
    if (viewportRef.value) {
      viewportRef.value.addEventListener('wheel', onWheel, { passive: false });
    }
  });

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize', onResize);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', onVisualViewportResize);
    }
    if (viewportRef.value) {
      viewportRef.value.removeEventListener('wheel', onWheel);
    }
    window.clearTimeout(reader.resizeTimer ?? undefined);
  });
}
