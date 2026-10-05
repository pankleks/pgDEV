import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { desktop } from './lib/desktop'

desktop()
createApp(App).mount('#app')
