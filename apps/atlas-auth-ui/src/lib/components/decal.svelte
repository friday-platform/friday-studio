<div aria-hidden="true" class="atlas-login-decal"></div>

<style>
  .atlas-login-decal {
    background: linear-gradient(180deg, #e3e7f1 0%, #faf4ed 54.93%, #fbfbf6 106.67%);
    background: linear-gradient(
      180deg,
      color(display-p3 0.8941 0.9059 0.9412) 0%,
      color(display-p3 0.9765 0.9569 0.9333) 54.93%,
      color(display-p3 0.9843 0.9843 0.9647) 106.67%
    );

    &:global(:first-of-type) {
      border-inline-end: var(--size-px) solid var(--border-1);
    }

    &:global(:last-of-type) {
      border-inline-start: var(--size-px) solid var(--border-1);
    }

    @media (prefers-color-scheme: dark) {
      background: linear-gradient(
        180deg,
        rgba(0, 50, 160, 0.1) 0%,
        rgba(26, 17, 8, 0.1) 54.93%,
        rgba(129, 89, 0, 0.1) 106.67%
      );

      background: linear-gradient(
        180deg,
        color(display-p3 0.0556 0.1926 0.6035 / 0.1) 0%,
        color(display-p3 0.0961 0.0693 0.0371 / 0.1) 54.93%,
        color(display-p3 0.4825 0.3546 0.0988 / 0.1) 106.67%
      );
    }
  }
</style>
