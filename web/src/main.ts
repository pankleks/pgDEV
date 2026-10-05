import { mount, unmount } from 'svelte'
import App from './App.svelte'
import './style.css'
import { desktop } from './lib/desktop'

desktop()
const target = document.getElementById('app')
if (!target) throw new Error('Application mount point is missing')
const application = mount(App, { target })
if (import.meta.hot) import.meta.hot.dispose(() => { void unmount(application) })
