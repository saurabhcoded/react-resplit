import {
  MutableRefObject,
  HTMLAttributes,
  ReactNode,
  forwardRef,
  useId,
  useRef,
  useState,
  useCallback,
  useMemo,
} from 'react';
import { Slot } from '@radix-ui/react-slot';

import { ResplitContext } from './ResplitContext';
import { RootContext } from './RootContext';
import { CURSOR_BY_DIRECTION, GRID_TEMPLATE_BY_DIRECTION } from './const';
import {
  convertFrToNumber,
  convertPxToNumber,
  convertSizeToFr,
  isPx,
  mergeRefs,
  useIsomorphicLayoutEffect,
} from './utils';

import type { FrValue, Order, PxValue, Direction } from './types';
import type { ResplitPaneOptions } from './Pane';
import type { ResplitSplitterOptions } from './Splitter';

/**
 * The state of an individual pane.
 *
 * @internal For internal use only.
 *
 * @see {@link PaneOptions} for the public API.
 */
export interface PaneChild {
  type: 'pane';
  onCollapse?: (paneSize: string) => void;
  onExpand?: (paneSize: string) => void;
  options: MutableRefObject<
    ResplitPaneOptions & {
      minSize: PxValue | FrValue;
      collapsedSize: PxValue | FrValue;
    }
  >;
}

/**
 * The state of an individual splitter.
 *
 * @internal For internal use only.
 *
 * @see {@link SplitterOptions} for the public API.
 */
export interface SplitterChild {
  type: 'splitter';
  options: MutableRefObject<
    ResplitSplitterOptions & {
      size: PxValue;
    }
  >;
}

/**
 * An object containing panes and splitters. Indexed by order.
 *
 * @internal For internal use only.
 */
export interface ChildrenState {
  [order: Order]: PaneChild | SplitterChild;
}

export interface ResplitOptions {
  /**
   * Direction of the panes.
   *
   * @defaultValue 'horizontal'
   *
   */
  direction?: Direction;
}

export type ResplitRootProps = ResplitOptions &
  HTMLAttributes<HTMLDivElement> & {
    /**
     * The children of the ResplitRoot component.
     */
    children: ReactNode;
    /**
     * Merges props onto the immediate child.
     *
     * @defaultValue false
     *
     * @example
     *
     * ```tsx
     * <ResplitRoot asChild>
     *   <main style={{ backgroundColor: 'red' }}>
     *     ...
     *   </main>
     * </ResplitRoot>
     * ```
     */
    asChild?: boolean;
  };

/**
 * The root component of a resplit layout. Provides context to all child components.
 *
 * @example
 * ```tsx
 * <ResplitRoot direction="horizontal">
 *   <ResplitPane order={0} />
 *   <ResplitSplitter order={1} />
 *   <ResplitPane order={2} />
 * </ResplitRoot>
 * ```
 */
export const ResplitRoot = forwardRef<HTMLDivElement, ResplitRootProps>(function Root(
  { direction = 'horizontal', children: reactChildren, style, asChild = false, ...rest },
  forwardedRef,
) {
  const id = useId();
  const Comp = asChild ? Slot : 'div';
  const activeSplitterOrder = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [children, setChildren] = useState<ChildrenState>({});

  const getChildElement = useCallback(
    (order: Order) => rootRef.current?.querySelector(`:scope > [data-resplit-order="${order}"]`),
    [],
  );

  const getChildSize = useCallback(
    (order: Order) => rootRef.current?.style.getPropertyValue(`--resplit-${order}`),
    [],
  );

  const getChildSizeAsNumber = useCallback(
    (order: Order) => {
      const childSize = getChildSize(order);
      if (!childSize) return 0;
      return isPx(childSize as PxValue | FrValue)
        ? convertPxToNumber(childSize as PxValue)
        : convertFrToNumber(childSize as FrValue);
    },
    [getChildSize],
  );

  const setChildSize = useCallback(
    (order: Order, size: FrValue | PxValue) => {
      rootRef.current?.style.setProperty(`--resplit-${order}`, size);
      const child = children[order];

      if (child.type === 'pane') {
        const paneSplitter = getChildElement(order + 1);
        paneSplitter?.setAttribute(
          'aria-valuenow',
          String(convertFrToNumber(size as FrValue).toFixed(2)),
        );
      }
    },
    [children, getChildElement],
  );

  const isPaneMinSize = useCallback(
    (order: Order) => getChildElement(order)?.getAttribute('data-resplit-is-min') === 'true',
    [getChildElement],
  );

  const isPaneDefaultCollapse = useCallback(
    (order: Order) =>
      getChildElement(order)?.getAttribute('data-resplit-default-collapsed') === 'true',
    [getChildElement],
  );

  const setIsPaneMinSize = useCallback(
    (order: Order, value: boolean) =>
      getChildElement(order)?.setAttribute('data-resplit-is-min', String(value)),
    [getChildElement],
  );

  const isPaneCollapsed = useCallback(
    (order: Order) => getChildElement(order)?.getAttribute('data-resplit-is-collapsed') === 'true',
    [getChildElement],
  );

  const isPaneExpanded = useCallback(
    (order: Order) => getChildElement(order)?.getAttribute('data-resplit-is-collapsed') === 'false',
    [getChildElement],
  );

  const setIsPaneCollapsed = useCallback(
    (order: Order, value: boolean) =>
      getChildElement(order)?.setAttribute('data-resplit-is-collapsed', String(value)),
    [getChildElement],
  );

  const getRootSize = useCallback(
    () =>
      (direction === 'horizontal' ? rootRef.current?.offsetWidth : rootRef.current?.offsetHeight) ||
      0,
    [direction],
  );

  const findResizablePane = useCallback(
    (start: number, direction: number) => {
      let index = start;
      let pane: PaneChild | null = children[index] as PaneChild;

      while (index >= 0 && index < Object.values(children).length) {
        const child = children[index];

        if (
          child.type === 'splitter' ||
          (isPaneMinSize(index) && !child.options.current.collapsible) ||
          (isPaneMinSize(index) && child.options.current.collapsible && isPaneCollapsed(index))
        ) {
          index += direction;
          pane = null;
        } else {
          pane = child;
          break;
        }
      }

      return { index, pane };
    },
    [children, isPaneCollapsed, isPaneMinSize],
  );

  const resizeByDelta = useCallback(
    (splitterOrder: Order, delta: number) => {
      const isGrowing = delta > 0;
      const isShrinking = delta < 0;

      // Find the previous and next resizable panes
      const { index: prevPaneIndex, pane: prevPane } = isShrinking
        ? findResizablePane(splitterOrder - 1, -1)
        : { index: splitterOrder - 1, pane: children[splitterOrder - 1] as PaneChild };

      const { index: nextPaneIndex, pane: nextPane } = isGrowing
        ? findResizablePane(splitterOrder + 1, 1)
        : { index: splitterOrder + 1, pane: children[splitterOrder + 1] as PaneChild };

      // Return if no panes are resizable
      if (!prevPane || !nextPane) return;

      const rootSize = getRootSize();

      const prevPaneOptions = prevPane.options.current;
      let prevPaneSize = getChildSizeAsNumber(prevPaneIndex) + delta;
      const prevPaneMinSize = convertFrToNumber(convertSizeToFr(prevPaneOptions.minSize, rootSize));
      const prevPaneisPaneMinSize = prevPaneSize <= prevPaneMinSize;
      const prevPaneisPaneCollapsed =
        !!prevPaneOptions.collapsible && prevPaneSize <= prevPaneMinSize / 2;

      const nextPaneOptions = nextPane.options.current;
      let nextPaneSize = getChildSizeAsNumber(nextPaneIndex) - delta;
      const nextPaneMinSize = convertFrToNumber(convertSizeToFr(nextPaneOptions.minSize, rootSize));
      const nextPaneisPaneMinSize = nextPaneSize <= nextPaneMinSize;
      const nextPaneisPaneCollapsed =
        !!nextPaneOptions.collapsible && nextPaneSize <= nextPaneMinSize / 2;

      if (prevPaneisPaneCollapsed || nextPaneisPaneCollapsed) {
        if (prevPaneisPaneCollapsed) {
          const prevPaneCollapsedSize = convertFrToNumber(
            convertSizeToFr(prevPaneOptions.collapsedSize, rootSize),
          );
          nextPaneSize = nextPaneSize + prevPaneSize - prevPaneCollapsedSize;
          prevPaneSize = prevPaneCollapsedSize;
        }

        if (nextPaneisPaneCollapsed) {
          const nextPaneCollapsedSize = convertFrToNumber(
            convertSizeToFr(nextPaneOptions.collapsedSize, rootSize),
          );
          prevPaneSize = prevPaneSize + nextPaneSize - nextPaneCollapsedSize;
          nextPaneSize = nextPaneCollapsedSize;
        }
      } else {
        if (prevPaneisPaneMinSize) {
          nextPaneSize = nextPaneSize + (prevPaneSize - prevPaneMinSize);
          prevPaneSize = prevPaneMinSize;
        }

        if (nextPaneisPaneMinSize) {
          prevPaneSize = prevPaneSize + (nextPaneSize - nextPaneMinSize);
          nextPaneSize = nextPaneMinSize;
        }
      }

      setChildSize(prevPaneIndex, `${prevPaneSize}fr`);
      setIsPaneMinSize(prevPaneIndex, prevPaneisPaneMinSize);
      const prevPaneCollapseEmit = isPaneExpanded(prevPaneIndex) && prevPaneisPaneCollapsed;
      const prevPaneExpandEmit = isPaneCollapsed(prevPaneIndex) && !prevPaneisPaneCollapsed;
      setIsPaneCollapsed(prevPaneIndex, prevPaneisPaneCollapsed);
      prevPaneOptions.onResize?.(`${prevPaneSize}fr`);
      if (prevPaneCollapseEmit) {
        prevPane?.onCollapse?.(`${prevPaneSize}fr`);
      } else if (prevPaneExpandEmit) {
        prevPane?.onExpand?.(`${prevPaneSize}fr`);
      }
      setChildSize(nextPaneIndex, `${nextPaneSize}fr`);
      setIsPaneMinSize(nextPaneIndex, nextPaneisPaneMinSize);
      const nextPaneCollapseEmit = isPaneExpanded(nextPaneIndex) && nextPaneisPaneCollapsed;
      const nextPaneExpandEmit = isPaneCollapsed(nextPaneIndex) && !nextPaneisPaneCollapsed;
      setIsPaneCollapsed(nextPaneIndex, nextPaneisPaneCollapsed);
      nextPaneOptions.onResize?.(`${nextPaneSize}fr`);
      if (nextPaneCollapseEmit) {
        prevPane?.onCollapse?.(`${prevPaneSize}fr`);
      } else if (nextPaneExpandEmit) {
        prevPane?.onExpand?.(`${prevPaneSize}fr`);
      }
    },
    [
      children,
      findResizablePane,
      getChildSizeAsNumber,
      getRootSize,
      setChildSize,
      setIsPaneMinSize,
      setIsPaneCollapsed,
    ],
  );

  /**
   * Mouse move handler
   * - Fire when user is interacting with splitter
   * - Handle resizing of panes
   */
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      // Return if no active splitter
      if (activeSplitterOrder.current === null) return;

      // Get the splitter element
      const splitter = getChildElement(activeSplitterOrder.current);

      // Return if no splitter element could be found
      if (!splitter) return;

      // Calculate available space
      const combinedSplitterSize = Object.entries(children).reduce(
        (total, [order, child]) =>
          total + (child.type === 'splitter' ? getChildSizeAsNumber(Number(order)) : 0),
        0,
      );

      const availableSpace = getRootSize() - combinedSplitterSize;

      // Calculate delta
      const splitterRect = splitter.getBoundingClientRect();
      const movement =
        direction === 'horizontal' ? e.clientX - splitterRect.left : e.clientY - splitterRect.top;
      const delta = movement / availableSpace;

      // Return if no change in the direction of movement
      if (!delta) return;

      resizeByDelta(activeSplitterOrder.current, delta);
    },
    [children, direction, getChildElement, getChildSizeAsNumber, getRootSize, resizeByDelta],
  );

  /**
   * Mouse up handler
   * - Fire when user stops interacting with splitter
   */
  const handleMouseUp = useCallback(() => {
    const order = activeSplitterOrder.current;

    if (order === null) return;

    // Set data attributes
    rootRef.current?.setAttribute('data-resplit-resizing', 'false');

    if (order !== null) {
      getChildElement(order)?.setAttribute('data-resplit-active', 'false');
    }

    const prevPane = children[order - 1];
    if (prevPane.type === 'pane')
      prevPane.options.current.onResizeEnd?.(getChildSize(order - 1) as FrValue);

    const nextPane = children[order + 1];
    if (nextPane.type === 'pane')
      nextPane.options.current.onResizeEnd?.(getChildSize(order + 1) as FrValue);

    // Unset refs
    activeSplitterOrder.current = null;

    // Re-enable text selection and cursor
    document.documentElement.style.cursor = '';
    document.documentElement.style.pointerEvents = '';
    document.documentElement.style.userSelect = '';

    // Remove mouse event listeners
    window.removeEventListener('mouseup', handleMouseUp);
    window.removeEventListener('mousemove', handleMouseMove);
  }, [children, getChildElement, getChildSize, handleMouseMove]);

  /**
   * Mouse down handler
   * - Fire when user begins interacting with splitter
   * - Handle resizing of panes using cursor
   */
  const handleSplitterMouseDown = useCallback(
    (order: number) => () => {
      // Set active splitter
      activeSplitterOrder.current = order;

      // Set data attributes
      rootRef.current?.setAttribute('data-resplit-resizing', 'true');

      if (activeSplitterOrder.current !== null) {
        getChildElement(activeSplitterOrder.current)?.setAttribute('data-resplit-active', 'true');
      }

      const prevPane = children[order - 1];
      if (prevPane.type === 'pane') prevPane.options.current.onResizeStart?.();

      const nextPane = children[order + 1];
      if (nextPane.type === 'pane') nextPane.options.current.onResizeStart?.();

      // Disable text selection and cursor
      document.documentElement.style.cursor = CURSOR_BY_DIRECTION[direction];
      document.documentElement.style.pointerEvents = 'none';
      document.documentElement.style.userSelect = 'none';

      // Add mouse event listeners
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('mousemove', handleMouseMove);
    },
    [direction, children, getChildElement, handleMouseUp, handleMouseMove],
  );

  /**
   * Key down handler
   * - Fire when user presses a key whilst focused on a splitter
   * - Handle resizing of panes using keyboard
   * - Refer to: https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/
   */
  const handleSplitterKeyDown = useCallback(
    (splitterOrder: number) => (e: React.KeyboardEvent<HTMLDivElement>) => {
      const isHorizontal = direction === 'horizontal';
      const isVertical = direction === 'vertical';

      if ((e.key === 'ArrowLeft' && isHorizontal) || (e.key === 'ArrowUp' && isVertical)) {
        resizeByDelta(splitterOrder, -0.01);
      } else if (
        (e.key === 'ArrowRight' && isHorizontal) ||
        (e.key === 'ArrowDown' && isVertical)
      ) {
        resizeByDelta(splitterOrder, 0.01);
      } else if (e.key === 'Home') {
        resizeByDelta(splitterOrder, -1);
      } else if (e.key === 'End') {
        resizeByDelta(splitterOrder, 1);
      } else if (e.key === 'Enter') {
        if (isPaneMinSize(splitterOrder - 1)) {
          const initialSize =
            (children[splitterOrder - 1] as PaneChild).options.current.initialSize || '1fr';
          resizeByDelta(splitterOrder, convertFrToNumber(initialSize));
        } else {
          resizeByDelta(splitterOrder, -1);
        }
      }
    },
    [direction, children, resizeByDelta, isPaneMinSize],
  );

  const registerPane = useCallback(
    (order: string, options: MutableRefObject<ResplitPaneOptions>) => {
      setChildren((children) => ({
        ...children,
        [order]: {
          type: 'pane',
          options,
        },
      }));
    },
    [],
  );

  const registerSplitter = useCallback(
    (order: string, options: MutableRefObject<ResplitSplitterOptions>) => {
      setChildren((children) => ({
        ...children,
        [order]: {
          type: 'splitter',
          options,
        },
      }));
    },
    [],
  );

  const setPaneSizes = useCallback(
    (paneSizes: FrValue[]) => {
      paneSizes.forEach((paneSize, index) => {
        const order = index * 2;
        setChildSize(order, paneSize);
        setIsPaneMinSize(
          order,
          (children[order] as PaneChild).options.current.minSize === paneSize,
        );
        setIsPaneCollapsed(
          order,
          (children[order] as PaneChild).options.current.collapsedSize === paneSize,
        );

        const pane = children[order] as PaneChild;
        if (pane.type === 'pane') {
          pane.options.current.onResize?.(paneSize);
        }
      });
    },
    [children, setChildSize, setIsPaneMinSize, setIsPaneCollapsed],
  );

  /**
   * Recalculate pane sizes when children are added or removed
   */
  const childrenLength = Object.keys(children).length;

  useIsomorphicLayoutEffect(() => {
    const paneCount = Object.values(children).filter((child) => child.type === 'pane').length;
    Object.keys(children).forEach((key) => {
      const order = Number(key);
      const child = children[order];

      if (child.type === 'pane') {
        const paneSize = isPaneMinSize(order)
          ? '0fr'
          : child.options.current.initialSize || `${1 / paneCount}fr`;
        setChildSize(order, paneSize);
      } else {
        setChildSize(order, child.options.current.size);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childrenLength]);

  const rootContextValue = useMemo(
    () => ({
      id,
      direction,
      registerPane,
      registerSplitter,
      handleSplitterMouseDown,
      handleSplitterKeyDown,
    }),
    [id, direction, registerPane, registerSplitter, handleSplitterMouseDown, handleSplitterKeyDown],
  );

  const resplitContextValue = useMemo(
    () => ({
      isPaneMinSize,
      isPaneCollapsed,
      setPaneSizes,
    }),
    [isPaneMinSize, isPaneCollapsed, setPaneSizes],
  );

  return (
    <RootContext.Provider value={rootContextValue}>
      <ResplitContext.Provider value={resplitContextValue}>
        <Comp
          ref={mergeRefs([rootRef, forwardedRef])}
          data-resplit-direction={direction}
          data-resplit-resizing={false}
          style={{
            display: 'grid',
            overflow: 'hidden',
            [GRID_TEMPLATE_BY_DIRECTION[direction]]: Object.keys(children).reduce(
              (value, order) => {
                const childVar = `minmax(0, var(--resplit-${order}))`;
                return value ? `${value} ${childVar}` : `${childVar}`;
              },
              '',
            ),
            ...style,
          }}
          {...rest}
        >
          {reactChildren}
        </Comp>
      </ResplitContext.Provider>
    </RootContext.Provider>
  );
});
