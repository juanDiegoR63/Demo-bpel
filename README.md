# Demo de Orquestación BPEL 🚀

Una aplicación web interactiva que demuestra conceptos de orquestación de procesos de negocio usando BPEL (Business Process Execution Language).

## 🐳 Despliegue con Docker

### Comandos básicos

```bash
# Construir imagen
docker build -t bpel-demo .

# Ejecutar contenedor
docker run -d --name bpel-demo -p 8080:80 bpel-demo

# Ver logs
docker logs bpel-demo

# Detener
docker stop bpel-demo
docker rm bpel-demo
```

### Acceso a la Aplicación

Una vez desplegada, la aplicación estará disponible en:
- **URL**: http://localhost:8080

## 🎯 Características de la Aplicación

- ✅ **Interfaz completamente en español**
- ✅ **Simulación de orquestación BPEL en tiempo real**
- ✅ **Control de velocidad avanzado (0.1x - 10x)**
- ✅ **Tres escenarios de prueba:**
  - Flujo exitoso (Happy Path)
  - Pago rechazado
  - Sin inventario (con compensación)
- ✅ **Código BPEL educativo con sintaxis coloreada**
- ✅ **Timeline de eventos en tiempo real**
- ✅ **Variables dinámicas JSON**
- ✅ **Modo oscuro/claro**
- ✅ **Funciones de copiar/descargar código BPEL**

## 🔧 Dockerfile

Simple y directo:
- **Base**: `nginx:alpine`
- **Puerto**: 80 (interno), mapeado a 8080 (externo)
- Solo copia los archivos HTML y JS

## 🛠️ Desarrollo

### Estructura de Archivos
```
bpel/
├── index.html              # Aplicación principal
├── main.js                 # Lógica de orquestación
├── Dockerfile              # Configuración Docker simple
└── README.md               # Documentación
```

## 🤝 Contribución

1. Fork el repositorio
2. Crear rama feature (`git checkout -b feature/nueva-funcionalidad`)
3. Commit cambios (`git commit -am 'Agregar nueva funcionalidad'`)
4. Push a la rama (`git push origin feature/nueva-funcionalidad`)
5. Crear Pull Request

## 📄 Licencia

Este proyecto es para fines educativos en el curso de Administración de Sistemas.

---

**Autor**: Demo BPEL Team  
**Curso**: Administración de Sistemas 2025-2  
**Tecnologías**: HTML5, JavaScript ES6, Tailwind CSS, Docker, Nginx