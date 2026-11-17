import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { SettingsStore } from '@iptvnator/services';
import { TranslateService } from '@ngx-translate/core';
import { EMPTY, of } from 'rxjs';
import { ContentCardComponent } from './content-card.component';
import { POSTER_PROXY_SHELL_CLASS } from './poster-proxy';

describe('ContentCardComponent poster cache', () => {
    let fixture: ComponentFixture<ContentCardComponent>;
    const poster = 'https://img.example.test/p/one.jpg';

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [ContentCardComponent],
            providers: [
                {
                    provide: SettingsStore,
                    useValue: { showCoverTitles: signal(false) },
                },
                {
                    provide: TranslateService,
                    useValue: {
                        onLangChange: of(),
                        onDefaultLangChange: EMPTY,
                        onTranslationChange: EMPTY,
                        currentLang: 'en',
                        defaultLang: 'en',
                    },
                },
            ],
        }).compileComponents();
        fixture = TestBed.createComponent(ContentCardComponent);
        fixture.componentRef.setInput('title', 'Sample Title');
        fixture.componentRef.setInput('posterUrl', poster);
        fixture.componentRef.setInput('type', 'movie');
    });

    afterEach(() => {
        document.documentElement.classList.remove(POSTER_PROXY_SHELL_CLASS);
    });

    const img = () => fixture.debugElement.query(By.css('img.poster'));
    const placeholder = () =>
        fixture.debugElement.query(By.css('.poster-placeholder'));

    it('loads the original poster outside the TV shell', () => {
        fixture.detectChanges();

        expect(img().nativeElement.getAttribute('src')).toBe(poster);
    });

    it('loads the cached copy in the TV shell', () => {
        document.documentElement.classList.add(POSTER_PROXY_SHELL_CLASS);

        fixture.detectChanges();

        expect(img().nativeElement.getAttribute('src')).toBe(
            `/api/image?url=${encodeURIComponent(poster)}&w=240`
        );
    });

    it('retries the original address once when the cache fails, then shows the placeholder', () => {
        document.documentElement.classList.add(POSTER_PROXY_SHELL_CLASS);
        fixture.detectChanges();

        img().triggerEventHandler('error');
        fixture.detectChanges();
        expect(img().nativeElement.getAttribute('src')).toBe(poster);

        img().triggerEventHandler('error');
        fixture.detectChanges();
        expect(img()).toBeNull();
        expect(placeholder()).not.toBeNull();
    });

    it('gives a new poster a fresh try through the cache', () => {
        document.documentElement.classList.add(POSTER_PROXY_SHELL_CLASS);
        fixture.detectChanges();
        img().triggerEventHandler('error');
        fixture.detectChanges();

        fixture.componentRef.setInput(
            'posterUrl',
            'https://img.example.test/p/two.jpg'
        );
        fixture.detectChanges();

        expect(img().nativeElement.getAttribute('src')).toContain('/api/image?url=');
    });
});
