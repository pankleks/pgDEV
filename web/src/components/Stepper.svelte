<script lang="ts">
  import { ChevronDown, ChevronUp } from '@lucide/svelte'

  interface Props {
    modelValue: number
    min: number
    max: number
    step?: number
    unit?: string
    onchange: (value: number) => void
  }

  let { modelValue, min, max, step = 1, unit, onchange }: Props = $props()

  function commit(raw: string) {
    const value = Number(raw)
    if (Number.isFinite(value)) onchange(value)
  }
  function bump(direction: 1 | -1) {
    onchange(Math.min(max, Math.max(min, modelValue + direction * step)))
  }
</script>

<div class="stepper">
  <input class="stepper-input" type="number" value={modelValue} {min} {max} {step}
    onchange={(event) => commit(event.currentTarget.value)} />
  {#if unit}<span class="stepper-unit">{unit}</span>{/if}
  <span class="stepper-sep"></span>
  <span class="stepper-btns">
    <button type="button" title={`Increase by ${step}`} onclick={() => bump(1)}><ChevronUp size={13} /></button>
    <button type="button" title={`Decrease by ${step}`} onclick={() => bump(-1)}><ChevronDown size={13} /></button>
  </span>
</div>
