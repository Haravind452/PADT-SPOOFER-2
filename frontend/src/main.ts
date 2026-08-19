import { createApp } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import App from './App.vue';

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'dark',
    themes: {
      dark: {
        dark: true,
        colors: {
          background: '#121216',
          surface: '#1c1c22',
          primary: '#29b6f6',
          secondary: '#2ecc71',
          error: '#e74c3c',
          warning: '#f39c12',
          info: '#969ca2',
          success: '#46d87f',
        },
      },
    },
  },
  defaults: {
    global: {
      ripple: false,
    },
    VBtn: {
      variant: 'text',
      style: {
        textTransform: 'none',
        letterSpacing: '0',
      },
    },
    VTextField: {
      variant: 'outlined',
      density: 'compact',
      hideDetails: 'auto',
      style: {
        fontSize: '13px',
      },
    },
    VSlider: {
      density: 'comfortable',
    },
    VCheckbox: {
      density: 'comfortable',
      hideDetails: 'auto',
      color: '#29b6f6',
    },
    VRadio: {
      color: '#29b6f6',
      hideDetails: 'auto',
      density: 'comfortable',
    },
  },
});

createApp(App).use(vuetify).mount('#app');