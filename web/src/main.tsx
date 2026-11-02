import React from 'react'
import { createRoot } from 'react-dom/client'
import { Dashboard } from './shell'
import '@nocoo/basalt/styles/standalone'
import './styles.css'

createRoot(document.getElementById('root')!).render(<React.StrictMode><Dashboard /></React.StrictMode>)
