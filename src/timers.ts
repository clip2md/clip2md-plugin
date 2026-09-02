export type TimerGroup = 'binding' | 'network' | 'settings-ui' | 'notice';

/** Small, group-aware registry for timers that need deterministic teardown. */
export class TimerRegistry {
    private readonly timeouts = new Map<number, TimerGroup>();
    private readonly intervals = new Map<number, TimerGroup>();

    private get timerHost(): Window {
        return window;
    }

    setTimeout(callback: () => void, delayMs: number, group: TimerGroup): number {
        let timerId = 0;
        timerId = this.timerHost.setTimeout(() => {
            this.timeouts.delete(timerId);
            callback();
        }, Math.max(0, delayMs));
        this.timeouts.set(timerId, group);
        return timerId;
    }

    setInterval(callback: () => void, delayMs: number, group: TimerGroup): number {
        const timerId = this.timerHost.setInterval(callback, Math.max(1, delayMs));
        this.intervals.set(timerId, group);
        return timerId;
    }

    clearTimeout(timerId: number | null | undefined): void {
        if (timerId === null || timerId === undefined) return;
        this.timerHost.clearTimeout(timerId);
        this.timeouts.delete(timerId);
    }

    clearInterval(timerId: number | null | undefined): void {
        if (timerId === null || timerId === undefined) return;
        this.timerHost.clearInterval(timerId);
        this.intervals.delete(timerId);
    }

    clearGroup(group: TimerGroup): void {
        for (const [timerId, timerGroup] of this.timeouts) {
            if (timerGroup === group) this.clearTimeout(timerId);
        }
        for (const [timerId, timerGroup] of this.intervals) {
            if (timerGroup === group) this.clearInterval(timerId);
        }
    }

    clearAll(): void {
        for (const timerId of [...this.timeouts.keys()]) this.clearTimeout(timerId);
        for (const timerId of [...this.intervals.keys()]) this.clearInterval(timerId);
    }

    get size(): number {
        return this.timeouts.size + this.intervals.size;
    }
}
