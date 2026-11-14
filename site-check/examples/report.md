**Colegio Ejemplo · Estado del sitio colegio.test**

Fecha: 14/10/2026 · Para: Dirección

**Resumen de Google** (PageSpeed, 14/10/2026; puntaje de 0 a 100)

| | Rendimiento | Accesibilidad | Buenas prácticas | SEO |
|---|---|---|---|---|
| Celular | ▲ 45 (Bajo) | ■ 88 (A mejorar) | ● 92 (Bien) | ■ 85 (A mejorar) |
| Computadora | ■ 78 (A mejorar) | ■ 88 (A mejorar) | ● 92 (Bien) | ■ 85 (A mejorar) |

## Qué se miró y qué no

Se revisó lo que cualquier persona puede ver desde afuera: cómo responde el sitio, cómo carga en un celular, cómo está configurado el dominio y el correo, y si el dominio figura en la lista de bloqueo de Spamhaus. No se entró al panel ni al hosting, así que lo que pasa adentro (usuarios, copias de seguridad, componentes instalados) no está en este informe.

## En cinco líneas

**36 chequeos aplicables:** ▲ 1 para arreglar ya · ■ 6 para revisar · ◆ 6 mejoras opcionales · ● 19 bien · ○ 4 que no se pudieron ver.

1. El correo del dominio no tiene la regla que les dice a Gmail y a Outlook qué hacer con los mails falsos.
2. El servidor activa 2 de las 6 protecciones que ofrecen los navegadores; la que obliga a usar la conexión segura está activa.
3. En celular, lo principal de la página tarda 4,8 segundos en aparecer; Google considera bien hasta 2,5 segundos.
4. Google puede mostrar la página principal y las internas.
5. Lo primero: configurar los registros que faltan en el dominio; después, plan de velocidad: imágenes, caché y lo que carga primero.

## Lo que conviene arreglar

Ordenado por lo que más riesgo trae si se deja como está.

### ▲ Arreglar ya (1)

| Qué se encontró | Qué puede pasar si queda así | Qué se hace | Quién |
|---|---|---|---|
| El correo del dominio no tiene la regla que les dice a Gmail y a Outlook qué hacer con los mails falsos | Se pueden enviar mails que parezcan del colegio y llegar, y los mails reales pueden caer más seguido en spam | Configurar los registros que faltan en el dominio | Quien administra el dominio |

### ■ Revisar (6)

| Qué se encontró | Qué puede pasar si queda así | Qué se hace | Quién |
|---|---|---|---|
| El servidor activa 2 de las 6 protecciones que ofrecen los navegadores; la que obliga a usar la conexión segura está activa | Es más fácil incrustar el sitio en otro o inyectarle contenido; el sitio no indica qué parte de sus direcciones ven los sitios que enlaza; el sitio no limita qué funciones del navegador, como la cámara o la ubicación, pueden usar sus páginas | Agregar las 4 protecciones que faltan (la que impide mostrar el sitio dentro de otro, la que limita qué contenido carga la página, la que fija qué se comparte con otros sitios y la que limita los permisos del navegador) y probar que nada se rompa | Quien mantiene el sitio |
| En celular, lo principal de la página tarda 4,8 segundos en aparecer; Google considera bien hasta 2,5 segundos | Quien entra desde el celular espera más de lo que Google considera aceptable en cada visita | Plan de velocidad: imágenes, caché y lo que carga primero | Quien mantiene el sitio, con acceso al panel |
| El sitio funciona con WordPress 6.1.1, de la rama de noviembre de 2022, y la versión se ve desde afuera | Alguien puede buscar fallas conocidas de esa versión y entrar | Actualizar en un entorno de prueba primero, con copia, y después ocultar la versión | Quien mantiene el sitio, con acceso al panel |
| El servidor no guarda páginas listas para servir: dos cargas seguidas, sin señal de caché | Cada visita obliga al servidor a armar la página de cero; con picos de visitas se pone lento | Activar caché de página, sin cachear los formularios | Quien mantiene el sitio |
| La página principal pesa 2,9 MB: 1,9 MB son imágenes y 0,3 MB llegan de servicios externos (YouTube, Google Tag Manager) | Cada visita desde un celular con datos móviles descarga todo eso antes de poder usar la página | Achicar y convertir las imágenes y revisar lo que se carga de afuera | Quien mantiene el sitio |
| El servidor anuncia qué programa usa y su versión exacta (Apache/2.4.41 (Ubuntu); PHP/7.4.33) | Le ahorra un paso a quien busca fallas conocidas | Pedirle al hosting que oculte las versiones | Quien mantiene el sitio, con el hosting |

### ◆ Mejora opcional (6)

| Qué se encontró | Qué puede pasar si queda así | Qué se hace | Quién |
|---|---|---|---|
| El título tiene 74 caracteres y la descripción 153; lo recomendado es 50 a 60 y 120 a 160 | Google los corta o los completa a su manera | Escribir título y descripción en el plugin de SEO, página por página clave | Quien mantiene el sitio |
| Uno de los 8 enlaces revisados de la página principal lleva a una página que no existe; otro da más de una vuelta antes de llegar | Las familias encuentran un error y Google pierde confianza en el sitio | Corregir cada enlace o su redirección | Quien mantiene el sitio |
| 2 textos de la página principal tienen poco contraste con su fondo | Cuesta leerlos con sol, en pantallas chicas o con la vista cansada | Ajustar colores en el tema hijo | Quien mantiene el sitio |
| El pie dice 2019 y la última novedad es de hace 28 meses | Quien visita el sitio piensa que nadie lo mira, y eso pesa al elegir colegio | Actualizar el pie, la portada y publicar novedades, o quitar la sección si no se usa | El colegio, con quien mantiene el sitio |
| Los datos del colegio están escritos una sola vez en el formato que lee Google; falta comprobar que Google los acepte | Sin esa prueba no se sabe si Google los usa | Pasarlos por la prueba de resultados enriquecidos de Google | Quien mantiene el sitio |
| 1 de las 3 imágenes de la página principal no tiene descripción | Las personas que usan lector de pantalla no saben qué muestran | Completar la descripción en la biblioteca de medios | Quien mantiene el sitio |

## Velocidad

Las tres primeras filas son de quienes visitaron la página principal desde un celular en los últimos 28 días, según Google; las otras dos se midieron el 14/10/2026.

| Qué se midió | Antes · 14/10/2026 | Qué significa |
|---|---|---|
| Cuánto tarda en aparecer lo principal de la página | 4,8 segundos | Google considera bien hasta 2,5 segundos |
| Cuánto tarda en responder cuando se toca algo | 0,2 segundos | Bien hasta 0,2 segundos |
| Cuánto se mueve la página mientras carga | 0,05 | Bien hasta 0,1 |
| Cuánto tarda el servidor en empezar a responder | menos de una décima de segundo | Bien hasta 0,8 segundos; un sitio de control medido en el mismo momento dio menos de una décima de segundo |
| Cuánto pesa la página principal | 2,9 MB | Google aconseja no pasar de 1,6 MB |

Datos de usuarios reales: Chrome UX Report (Google), CC BY 4.0

## Correo del dominio

| Protección | Estado | Qué significa |
|---|---|---|
| Quién puede enviar en nombre del dominio | configurada | Solo los servicios de correo autorizados por el dominio |
| Firma de los mensajes | no se pudo confirmar desde afuera | Se revisa en el panel de correo |
| Qué hacer con los mensajes falsos | falta | Hoy nadie le dice a Gmail o a Outlook que rechacen un mail falso |

## Lo que está bien

<details><summary>● 19 cosas bien</summary>

| Qué | Por qué importa |
|---|---|
| Google puede mostrar la página principal y las internas | El sitio aparece cuando lo buscan |
| La conexión segura es válida y vence el 11 de diciembre de 2026, en 58 días (la calificación y los protocolos viejos no se midieron) | Nadie ve advertencias en el navegador y los datos de los formularios viajan protegidos |
| El dominio vence el 2 de mayo de 2027 | Hay tiempo para confirmar la renovación antes de que venza |
| Con o sin www, y aunque se escriba sin la s de seguro, el sitio lleva siempre a una sola dirección con conexión segura | Las familias y Google llegan siempre al mismo sitio protegido |
| El servidor empieza a responder en menos de una décima de segundo | La página arranca rápido aunque la red sea lenta |
| Al compartir el sitio aparece imagen, título y descripción | El enlace se ve completo en WhatsApp y en redes |
| Todo lo que carga la página viaja con conexión segura | El candado se ve completo |
| La página principal viaja comprimida (6 KB → 2 KB) y por el protocolo moderno | Carga menos datos de los que pesa |
| El sitio publica su política de privacidad | Las familias saben para qué se usan sus datos |
| El sitio le da a Google el mapa de sus páginas | Google encuentra las páginas nuevas sin esperar |
| Cada página indica su propia dirección oficial | Google no se confunde entre copias |
| La página principal lleva a inscripciones en un toque | Las familias interesadas llegan directo |
| El botón de WhatsApp lleva a un número bien escrito | Las familias escriben en un toque |
| El código de la página principal no tiene partes para Internet Explorer ni contenido para Flash | El código de la portada no arrastra partes para navegadores que ya no se usan |
| Los dominios de las direcciones de correo publicadas tienen dónde recibir mails | Lo que escriben tiene a dónde llegar; cada casilla en sí no se puede comprobar desde afuera |
| Cada página tiene un solo título principal y sus subtítulos en orden | Google y los lectores de pantalla entienden la estructura |
| La página declara que está en castellano y tiene título propio | Los lectores de pantalla la leen bien |
| Hay botones para llamar y para escribir por WhatsApp en la página principal, y uno de ellos en el pie | Las familias llegan en un toque |
| No quedan textos ni enlaces de ejemplo de la plantilla | El sitio se ve terminado |

</details>

## Lo que no se pudo ver desde afuera

<details><summary>○ 4 cosas que no se pudieron ver</summary>

- ¿Google o las listas de correo marcan al sitio como peligroso? La lista de Spamhaus no marca el dominio; la de Google no se consultó en este chequeo.
- ¿Google muestra páginas ajenas dentro del sitio? Lo que Google muestra del sitio no se consultó en este chequeo.
- ¿Se puede usar en un celular angosto y con zoom al 200 %? Cómo se ve en un celular angosto y con el zoom al doble requiere una prueba en navegador, que se hace aparte.
- ¿Los formularios se entienden y los botones se pueden tocar? La página principal no tiene formularios para revisar; los de otras páginas se revisan en navegador.

</details>

### Lo que solo se ve con acceso al sitio

- Usuarios y cuentas del panel.
- Copias de seguridad y si restauran.
- Componentes instalados y sus versiones.
- Archivos y base de datos.

Eso solo se revisa con acceso autorizado al sitio.

**Próximo paso recomendado:** Corregir primero lo marcado para arreglar ya y para revisar, porque el correo del dominio no tiene la regla que les dice a Gmail y a Outlook qué hacer con los mails falsos.

## Cómo se midió

Herramientas: la herramienta de velocidad de Google (PageSpeed), la lectura de las respuestas del servidor, la consulta del DNS del dominio, la consulta pública del registro del dominio, la lista de bloqueo de Spamhaus y la lista pública de versiones de WordPress. Condiciones: 14/10/2026, de 10:00 a 10:00, desde Buenos Aires; celular, tres corridas con el valor del medio, y computadora, una corrida; tiempo del servidor medido tres veces, con un sitio de control en el mismo momento. Se hicieron 24 pedidos a su sitio en 1 minuto, de a uno por vez y con pausas. Las mediciones y las salidas completas quedan a disposición, y el anexo técnico con el estado de cada chequeo va aparte.

---

Informe generado con site-check 1.0.0, sin inteligencia artificial: la misma medición da siempre este texto.
