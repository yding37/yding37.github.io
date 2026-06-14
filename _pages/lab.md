---
layout: page
permalink: /lab/
title: Lab
description: 
nav: true
nav_order: 1
people_categories: [Doctoral, Masters, Undergraduate, Visiting Researcher, Past]
horizontal: true
---
<div id="carouselExampleIndicators" class="carousel slide" data-ride="carousel">
  <div class="carousel-inner">
    <div class="carousel-item">
      <img class="d-block w-100" src="../assets/img/hike-2024.jpeg">
    </div>
    <div class="carousel-item">
      <img class="d-block w-100" src="../assets/img/dinner-2024.jpeg">
    </div>
    <div class="carousel-item">
      <img class="d-block w-100" src="../assets/img/reading_group.jpeg">
    </div>
    <div class="carousel-item active">
      <img class="d-block w-100" src="../assets/img/holiday_lunch.jpg">
    </div>
    <div class="carousel-item">
      <img class="d-block w-100" src="../assets/img/lab-pc-building-2023.jpeg">
    </div>
  </div>
  <a class="carousel-control-prev" href="#carouselExampleIndicators" role="button" data-slide="prev">
    <span class="carousel-control-prev-icon" aria-hidden="true"></span>
    <span class="sr-only">Previous</span>
  </a>
  <a class="carousel-control-next" href="#carouselExampleIndicators" role="button" data-slide="next">
    <span class="carousel-control-next-icon" aria-hidden="true"></span>
    <span class="sr-only">Next</span>
  </a>
</div>

<div class="projects">
  <!-- Display categorized projects -->
  {%- for category in page.people_categories %}
  <h2 class="category">{{ category }}</h2>
  {%- assign categorized_people = site.lab | where: "category", category -%}

  {%- if categorized_people %}
  {%- assign sorted_people = categorized_people | sort: "importance" %}
  <!-- Generate cards for each project -->
  <div class="container row g-1">
    {%- for person in sorted_people -%}
    <!-- <div class="row g-1"> -->
    <div class="float-left col-md-6 justify-content-center">
      {% include people_horizontal.html %}
    </div>
    {%- endfor %}
  </div>
  {% endif %}
  {% endfor %}
</div>



