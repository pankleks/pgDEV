<script lang="ts">
  let { modelValue, label, onchange }: { modelValue: boolean; label: string; onchange: (value: boolean) => void } = $props()
</script>

<button type="button" class="toggle" class:on={modelValue} role="switch"
  aria-checked={modelValue} aria-label={label} onclick={() => onchange(!modelValue)}>
  <span class="knob"></span>
</button>
