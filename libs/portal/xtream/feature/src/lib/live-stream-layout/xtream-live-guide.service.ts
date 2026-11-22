import {
    afterNextRender,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    Injectable,
    Injector,
    Signal,
    signal,
    untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
    EpgPreferencesService,
    RuntimeCapabilitiesService,
} from '@iptvnator/services';
import {
    focusIfFocusLost,
    isTypingInInput,
    WorkspaceHeaderContextService,
} from '@iptvnator/portal/shared/util';
import {
    EpgProgrammeDialogService,
    persistEpgGuideDockCollapsed,
    restoreEpgGuideDockCollapsed,
} from '@iptvnator/ui/epg';
import { XtreamStore } from '@iptvnator/portal/xtream/data-access';
import { XtreamEpgGuideSourceService } from './xtream-epg-guide-source.service';

const ACTION = 'xtream-epg-guide';

/**
 * TV mode: the programme guide is the live TV screen (it opens on its own, with no channel
 * playing, and the page's own player stays hidden: channels play in the built-in player).
 * Active in the TV shell only. Kill switch: `localStorage['tv-guide'] = 'off'`.
 */
export function isTvGuideEnabled(doc: Document = document): boolean {
    if (!doc.documentElement.classList.contains('tv-shell')) return false;
    try {
        return doc.defaultView?.localStorage?.getItem('tv-guide') !== 'off';
    } catch {
        return true;
    }
}

@Injectable()
export class XtreamLiveGuideService {
    private readonly source = inject(XtreamEpgGuideSourceService);
    private readonly store = inject(XtreamStore);
    private readonly programmes = inject(EpgProgrammeDialogService);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly preferences = inject(EpgPreferencesService);
    private readonly header = inject(WorkspaceHeaderContextService);
    private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
    private readonly injector = inject(Injector);
    private readonly destroyRef = inject(DestroyRef);
    private readonly playing = signal<Signal<boolean> | null>(null);
    private returnFocus: HTMLElement | null = null;

    readonly tvMode = isTvGuideEnabled();
    readonly isOpen = signal(false);
    readonly collapsed = signal(restoreEpgGuideDockCollapsed());
    private readonly enabled = computed(
        () => this.runtime.supportsProviderEpg && this.preferences.enabled()
    );
    private readonly playlistId = computed(() => this.source.playlist()?.id);
    readonly available = computed(
        () =>
            this.enabled() &&
            (this.tvMode || !!this.playing()?.()) &&
            !!this.playlistId()
    );

    constructor() {
        effect((onCleanup) => {
            const playlistId = this.playlistId();
            if (!playlistId || !this.enabled()) return;
            const action = {
                id: ACTION,
                owner: { provider: 'xtreams', playlistId, section: 'live' },
                icon: 'grid_view',
                tooltipKey: 'TOP_MENU.OPEN_EPG_GUIDE',
                ariaLabelKey: 'TOP_MENU.OPEN_EPG_GUIDE',
                active: this.isOpen,
                disabled: () => !this.available(),
                hidesContextPanel: this.isOpen,
                palette: {
                    labelKey: 'TOP_MENU.OPEN_EPG_GUIDE',
                    descriptionKey:
                        'WORKSPACE.SHELL.COMMANDS.OPEN_EPG_GUIDE_DESCRIPTION',
                    keywords: ['epg', 'guide', 'schedule'],
                    priority: 10,
                },
                run: () => {
                    if (this.header.action() === action) this.toggle();
                },
            };
            this.header.setAction(action);
            onCleanup(() =>
                untracked(() => {
                    if (this.header.action() === action)
                        this.header.clearAction(ACTION);
                    this.close();
                })
            );
        });
        effect(() => {
            if (!this.available()) untracked(() => this.close());
        });
        effect(() => {
            // TV mode: Live TV shows the categories first; picking one opens the guide for it.
            // Closing the guide goes back to the categories (closeToCategories), so picking
            // another category opens the guide again.
            if (!this.tvMode || !this.available()) return;
            if (this.store.selectedCategoryId() === null) return;
            afterNextRender(() => untracked(() => this.open()), {
                injector: this.injector,
            });
        });
        this.destroyRef.onDestroy(() => this.source.close());
    }

    bind(playing: Signal<boolean>): void {
        this.playing.set(playing);
    }

    open(): void {
        if (
            this.destroyRef.destroyed ||
            this.isOpen() ||
            !this.available() ||
            this.blocked()
        )
            return;
        const focused = document.activeElement;
        this.returnFocus =
            focused instanceof HTMLElement && focused !== document.body
                ? focused
                : null;
        this.source.open();
        this.isOpen.set(true);
        afterNextRender(
            () =>
                this.element.nativeElement
                    .querySelector<HTMLElement>('.epg-guide-host')
                    ?.focus(),
            { injector: this.injector }
        );
    }

    close(): void {
        if (!this.isOpen()) return;
        const focused = document.activeElement;
        const dialogClosed = this.programmes.ownedAfterClosed(focused);
        const restoreFocus =
            !!dialogClosed ||
            (focused instanceof Element &&
                !!focused.closest(
                    '.epg-guide-host, app-epg-guide-now-playing'
                ));
        this.isOpen.set(false);
        this.source.close();
        if (restoreFocus && !this.destroyRef.destroyed) {
            const previous = this.returnFocus;
            const workspace = this.element.nativeElement.closest<HTMLElement>(
                'main.workspace-content'
            );
            const handoff = () => {
                if (this.destroyRef.destroyed || this.isOpen()) return;
                focusIfFocusLost(previous);
                focusIfFocusLost(
                    document.querySelector<HTMLElement>(
                        `[data-test-id="${ACTION}"]`
                    )
                );
                focusIfFocusLost(workspace);
            };
            if (dialogClosed)
                dialogClosed
                    .pipe(takeUntilDestroyed(this.destroyRef))
                    .subscribe(() => queueMicrotask(handoff));
            else afterNextRender(handoff, { injector: this.injector });
        }
    }

    /** TV mode: leaving the guide goes back to the categories, never to the old channel list and player. */
    closeToCategories(): void {
        this.close();
        if (this.tvMode && !this.destroyRef.destroyed) {
            this.store.setSelectedCategory(null);
        }
    }

    toggle(): void {
        if (this.isOpen()) this.closeToCategories();
        else this.open();
    }

    setCollapsed(collapsed: boolean): void {
        this.collapsed.set(collapsed);
        persistEpgGuideDockCollapsed(collapsed);
    }

    handleKey(event: KeyboardEvent): void {
        const escapeDock =
            event.key === 'Escape' &&
            this.isOpen() &&
            event.target instanceof Element &&
            this.element.nativeElement.contains(event.target) &&
            !!event.target.closest('app-epg-guide-now-playing');
        if (
            event.defaultPrevented ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            isTypingInInput(event) ||
            (!escapeDock && event.key.toLowerCase() !== 'g') ||
            (!this.isOpen() && !this.available()) ||
            this.blocked() ||
            event
                .composedPath()
                .some(
                    (target) =>
                        target instanceof Element &&
                        target.matches('.cdk-overlay-pane')
                )
        )
            return;
        if (escapeDock) this.close();
        else if (!event.repeat) this.toggle();
        event.preventDefault();
    }

    closeOnFullscreen(): void {
        if (document.fullscreenElement) this.close();
    }

    private blocked(): boolean {
        return (
            !!document.fullscreenElement ||
            !!this.element.nativeElement.closest('[inert]') ||
            !!document.querySelector(
                '.cdk-overlay-pane [role="dialog"], .cdk-overlay-pane [role="menu"]'
            )
        );
    }
}
